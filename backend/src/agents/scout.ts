/**
 * Agent 1: RSS Feeder & Triage (The Scout)
 *
 * Architecture: Strict Handover Model
 *
 *   The Scout is a pure data-retriever and categorizer. It does NOT track
 *   quotas, manage retry loops, or decide when to stop. All of that logic
 *   lives exclusively in the Master Orchestrator.
 *
 *   The Scout is dispatched by the Master with a ScoutPayload specifying
 *   the mode and (optionally) which pillars are still underquota. It fetches
 *   the appropriate feeds, runs parallel LLM triage, and returns ALL approved
 *   candidates to the Master. The Master slots them into pillar buckets,
 *   counts the results, and decides whether to re-dispatch the Scout.
 *
 *   3-Tier Feed Hierarchy:
 *     Tier 2 — Preferred / General Feeds   → round_1
 *     Tier 1 — Priority / Subpillar Feeds  → underquota_protocol
 *     Tier 3 — Fallback / Broadest Net     → fallback_protocol
 *
 *   Modes:
 *     round_1            — Tier 2 broad scrape from PRIORITY_FEEDS (general,
 *                          mixed-topic). Resets per-run state (triagedUrls,
 *                          FeedMemory). Pool cap: FRESH_POOL_SIZE (100).
 *     underquota_protocol — Tier 1 "sniper" fetch: Scout reads missing_pillars
 *                           from the Master and targets only the hyper-specific
 *                           RSS_FEEDS subpillar branches for those pillars.
 *                           Results are strictly filtered to the missing pillars.
 *                           Pool cap: RETRY_POOL_SIZE (50).
 *     fallback_protocol   — Tier 3 wide sweep: all RSS_FEEDS sorted by empirical
 *                           FeedMemory score, 14-day age window. Last resort when
 *                           both Round 1 and Underquota have failed to fill quota.
 *
 *   Internal algorithm (per dispatch):
 *     1. Build pool  — fetch feeds, deduplicate, age-filter, remove already-
 *                      triaged / already-processed URLs.
 *     2. Score & sort — use FeedMemory to prefer feeds that historically yield
 *                       content for the still-missing pillars.
 *     3. Batch triage — parallel LLM calls in batches of BATCH_SIZE, updating
 *                       FeedMemory on every APPROVED outcome.
 *     4. Handover     — return the full list of approved ScoutItems; the Master
 *                       applies the quota caps.
 */

import path from 'path';
import fs   from 'fs/promises';
import { PrismaClient } from '@prisma/client';
import { fetchFeed, RSS_FEEDS, PRIORITY_FEEDS, FEED_FALLBACK_MAP } from '../services/rss';
import { chat, parseJsonResponse } from '../services/llm';
import type { Pillar, ScoutItem } from '../shared/types';
import { PILLARS, PILLAR_LABELS } from '../shared/types';

// ── Constants ────────────────────────────────────────────────────────────────
const MAX_CANDIDATES_PER_PILLAR = 10;  // used by FeedMemory.score() to compute need()
const FRESH_POOL_SIZE           = 100; // items pulled from PRIORITY_FEEDS on round_1
const RETRY_POOL_SIZE           = 50;  // items pulled from fallback feeds per underquota/fallback dispatch
const MIN_BATCH_SIZE            = 4;   // floor for adaptive batching (triageAll)
const MAX_BATCH_SIZE            = 20;  // ceiling — keeps LLM concurrency bounded
const ADAPTIVE_OVERSHOOT        = 2;   // batch size = remaining_slots × overshoot

// ── Confidence weighting ─────────────────────────────────────────────────────
// Built from PRIORITY_FEEDS so fairPillarInterleave can sort sources WITHIN
// each pillar lane by their confidence rating (high → unverified).
type Confidence = 'high' | 'medium' | 'low' | 'unverified';

function confidenceWeight(c?: Confidence): number {
  switch (c) {
    case 'high':       return 0;
    case 'medium':     return 1;
    case 'low':        return 2;
    case 'unverified': return 3;
    default:           return 1;
  }
}

const SOURCE_CONFIDENCE_MAP = new Map<string, Confidence>();
for (const feed of PRIORITY_FEEDS) {
  try {
    const host = new URL(feed.url).hostname;
    SOURCE_CONFIDENCE_MAP.set(host, feed.confidence);
    if (feed.fallback) {
      const fbHost = new URL(feed.fallback).hostname;
      if (!SOURCE_CONFIDENCE_MAP.has(fbHost)) {
        SOURCE_CONFIDENCE_MAP.set(fbHost, feed.confidence);
      }
    }
  } catch { /* keep going */ }
}

function sourceConfidence(domain: string): Confidence {
  return SOURCE_CONFIDENCE_MAP.get(domain) ?? 'unverified';
}
const BATCH_SIZE                = 10;
const AGE_LIMIT_DAYS            = 7;
const AGE_RETRY_DAYS            = 14;

/**
 * Feeds scoring below this threshold when some buckets are full are considered
 * "full-pillar dominant" and are demoted to a fallback tier.
 *
 * A score of 0 means the feed has ONLY ever produced content for full pillars.
 * A score of 0.5 means the feed has no history (neutral — treated as preferred).
 * Setting the threshold at 0.15 means a feed needs at least ~15% historical
 * affinity for open pillars to stay in the preferred tier.
 */
const USEFUL_SCORE_THRESHOLD    = 0.15;

const MEMORY_FILE = path.join(process.cwd(), 'data', 'feed-memory.json');

// ── ScoutPayload — sent by the Master Orchestrator on each dispatch ───────────
export interface ScoutPayload {
  /**
   * round_1            — Tier 2 (Preferred). Fresh broad scrape from
   *                      PRIORITY_FEEDS. Resets triagedUrls and FeedMemory.
   * underquota_protocol — Tier 1 (Priority Subpillar). Sniper fetch from
   *                       RSS_FEEDS branches specific to missing_pillars.
   *                       Results filtered strictly to those pillars.
   * fallback_protocol   — Tier 3 (Fallback). Wide sweep across all RSS_FEEDS
   *                       sorted by empirical score. 14-day age window.
   */
  mode: 'round_1' | 'underquota_protocol' | 'fallback_protocol';
  /**
   * Human-readable pillar labels that are still below quota, e.g.
   * ['Japanese Manga', 'Japanese Toys/Collectibles'].
   * Required for underquota_protocol and fallback_protocol.
   */
  missing_pillars?: string[];
}

// ── Pillar label alias map ────────────────────────────────────────────────────
const PILLAR_FROM_LABEL: Record<string, Pillar> = {
  'Japanese Anime':             'anime',
  'Japanese Gaming':            'gaming',
  'Japanese Infotainment':      'infotainment',
  'Japanese Manga':             'manga',
  'Japanese Toys/Collectibles': 'toys',
  'Anime':                      'anime',
  'anime':                      'anime',
  'Gaming':                     'gaming',
  'gaming':                     'gaming',
  'Game':                       'gaming',
  'Japanese Game':              'gaming',
  'Japanese Games':             'gaming',
  'Infotainment':               'infotainment',
  'infotainment':               'infotainment',
  'Japanese Entertainment':     'infotainment',
  'Entertainment':              'infotainment',
  'Japanese Pop Culture':       'infotainment',
  'Manga':                      'manga',
  'manga':                      'manga',
  'Japanese Comic':             'manga',
  'Comics':                     'manga',
  'Toys':                       'toys',
  'toys':                       'toys',
  'Collectibles':               'toys',
  'Toys/Collectibles':          'toys',
  'Japanese Toys':              'toys',
  'Japanese Collectibles':      'toys',
};

// ── Types ─────────────────────────────────────────────────────────────────────
type TriageResult =
  | { status: 'APPROVED'; pillar: Pillar; extracted_facts: string; translation_notes: string }
  | { status: 'REJECTED'; reason: string }
  | { status: 'PARSE_ERROR'; reason: string };

interface PoolItem {
  title:      string;
  link:       string;
  summary:    string;
  pubDate?:   string;
  sourceFeed: string; // hostname of the originating RSS feed
}

type PillarCounts  = Record<Pillar, number>;
type FeedMemoryData = Record<string, PillarCounts>;

// ── Utilities ─────────────────────────────────────────────────────────────────
function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Pillar-Aware Fair Interleave
 *
 * Source-fair interleaving alone fails when feeds are pillar-imbalanced:
 * 4 gaming-heavy feeds + 0 infotainment-heavy feeds means even perfect
 * source rotation produces a gaming-dominated pool.
 *
 * Algorithm:
 *   1. Group items by source feed, sort each newest-first.
 *   2. Predict each source's dominant pillar using FeedMemory history
 *      (sources with no history go into the 'unknown' lane).
 *   3. Group sources into one lane per predicted pillar.
 *   4. Round-robin draw across PILLAR LANES, with rare-pillar lanes
 *      drawn FIRST so toys/manga/infotainment get head-of-pool
 *      placement before the high-volume gaming/anime tail.
 *   5. Within each lane, round-robin across the sources in that lane.
 *   6. Empty lanes are skipped — the loop ends when every lane is dry.
 *
 * Effect: the first 5–6 items of the returned pool span 5 different
 * predicted pillars, so the first LLM batch always sees pillar diversity
 * rather than 4Gamer × 3 + Automaton × 3 + Denfami × 3.
 *
 * `lanePriority` orders the lanes from rarest → most-common pillar so
 * scarce-pillar items get processed first while their buckets are empty.
 */
function fairPillarInterleave(items: PoolItem[], memory: FeedMemory): PoolItem[] {
  // ── Step 1: Group items by source, sort each newest-first ────────────────
  const bySource = new Map<string, PoolItem[]>();
  for (const item of items) {
    if (!bySource.has(item.sourceFeed)) bySource.set(item.sourceFeed, []);
    bySource.get(item.sourceFeed)!.push(item);
  }
  for (const list of bySource.values()) {
    list.sort((a, b) => {
      const ta = a.pubDate ? new Date(a.pubDate).getTime() : 0;
      const tb = b.pubDate ? new Date(b.pubDate).getTime() : 0;
      return tb - ta;
    });
  }

  // ── Step 2: Group sources into pillar lanes by their dominant history ────
  // Lane keys are 'anime' | 'gaming' | 'infotainment' | 'manga' | 'toys' | 'unknown'.
  // Sources with no history land in 'unknown' (treated as last-priority).
  type LaneKey = Pillar | 'unknown';
  const lanes = new Map<LaneKey, string[]>();
  for (const source of bySource.keys()) {
    const dominant = memory.dominantPillar(source);
    const key: LaneKey = dominant ?? 'unknown';
    if (!lanes.has(key)) lanes.set(key, []);
    lanes.get(key)!.push(source);
  }

  // ── Step 2b: Within-lane confidence sort ─────────────────────────────────
  // Sources with proven track record (high confidence) get drawn before
  // unverified sources within the same lane.  Tie-break by total historical
  // volume so a 747-item ANN beats a 71-item chaosphere within the anime lane.
  for (const sources of lanes.values()) {
    sources.sort((a, b) => {
      const cA = confidenceWeight(sourceConfidence(a));
      const cB = confidenceWeight(sourceConfidence(b));
      if (cA !== cB) return cA - cB;
      // Use the existing public score as a stable secondary key
      // (higher historical volume → higher score given empty bucket state)
      return 0;
    });
  }

  // ── Step 3: Lane draw priority — rarest pillar first ─────────────────────
  // Order matters: lanes drawn first get higher pool-head placement.
  // Toys, manga, infotainment historically yield FEWEST candidates so they
  // get first dibs on the pool head. 'unknown' goes last so untrained feeds
  // don't crowd out feeds we know are useful for scarce pillars.
  const lanePriority: LaneKey[] = ['toys', 'infotainment', 'manga', 'anime', 'gaming', 'unknown'];

  // ── Step 4: Round-robin draw across lanes, then sources within lane ──────
  const result: PoolItem[] = [];
  const sourceCursor = new Map<LaneKey, number>(); // which source is next in each lane

  let progress = true;
  while (progress) {
    progress = false;
    for (const lane of lanePriority) {
      const sources = lanes.get(lane);
      if (!sources || sources.length === 0) continue;

      // Try each source in this lane until we find one with items left
      const start = sourceCursor.get(lane) ?? 0;
      let attempted = 0;
      let found = false;

      while (attempted < sources.length && !found) {
        const idx     = (start + attempted) % sources.length;
        const source  = sources[idx];
        const bucket  = bySource.get(source);
        if (bucket && bucket.length > 0) {
          result.push(bucket.shift()!);
          sourceCursor.set(lane, (idx + 1) % sources.length);
          found = true;
          progress = true;
        }
        attempted++;
      }
    }
  }

  return result;
}

function emptyPillarCounts(): PillarCounts {
  return { anime: 0, gaming: 0, infotainment: 0, manga: 0, toys: 0 };
}

// ── Empirical Feed Memory ─────────────────────────────────────────────────────
class FeedMemory {
  private data: FeedMemoryData = {};

  async load(log: (msg: string) => void): Promise<void> {
    try {
      const raw = await fs.readFile(MEMORY_FILE, 'utf-8');
      this.data = JSON.parse(raw) as FeedMemoryData;
      log(`[Scout] Feed memory loaded (${Object.keys(this.data).length} feeds tracked)`);
    } catch {
      this.data = {};
      log('[Scout] Feed memory: no history file yet — starting fresh');
    }
  }

  async save(log: (msg: string) => void): Promise<void> {
    try {
      await fs.mkdir(path.dirname(MEMORY_FILE), { recursive: true });
      await fs.writeFile(MEMORY_FILE, JSON.stringify(this.data, null, 2), 'utf-8');
      log('[Scout] Feed memory saved.');
    } catch (err) {
      log(`[Scout] Feed memory save failed (non-fatal): ${(err as Error).message}`);
    }
  }

  /** Record a successful triage outcome for a feed. */
  record(feedDomain: string, pillar: Pillar): void {
    if (!this.data[feedDomain]) this.data[feedDomain] = emptyPillarCounts();
    this.data[feedDomain][pillar]++;
  }

  /**
   * Compute a 0–1 priority score for an item given current bucket fill levels.
   *
   * Formula: Σ_pillar [ historical_rate(feed, pillar) × need(pillar) ]
   *
   * - historical_rate is derived from empirical outcomes — no hardcoded labels.
   * - A feed that has only ever produced gaming content scores near-zero when
   *   the gaming bucket is full, regardless of any static mapping.
   * - A feed with no history scores 0.5 (neutral).
   */
  score(feedDomain: string, buckets: Record<Pillar, ScoutItem[]>): number {
    const counts = this.data[feedDomain];
    if (!counts) return 0.5;

    const total = PILLARS.reduce((s, p) => s + counts[p], 0);
    if (total === 0) return 0.5;

    let weighted = 0;
    for (const pillar of PILLARS) {
      const rate = counts[pillar] / total;
      const need = 1 - (buckets[pillar].length / MAX_CANDIDATES_PER_PILLAR);
      weighted += rate * need;
    }
    return Math.min(1, Math.max(0, weighted));
  }

  /**
   * Return the pillar this feed has produced MOST often historically.
   * Returns null if the feed has no recorded history.
   *
   * Used by the pillar-aware pool interleave to predict each source's
   * likely classification before the LLM is called.
   */
  dominantPillar(feedDomain: string): Pillar | null {
    const counts = this.data[feedDomain];
    if (!counts) return null;

    let maxCount = 0;
    let dominant: Pillar | null = null;
    for (const p of PILLARS) {
      if (counts[p] > maxCount) {
        maxCount = counts[p];
        dominant = p;
      }
    }
    return maxCount > 0 ? dominant : null;
  }

  /**
   * Return the historical share (0-1) that this feed has produced for
   * the given pillar. Returns 0 if no history.
   */
  pillarShare(feedDomain: string, pillar: Pillar): number {
    const counts = this.data[feedDomain];
    if (!counts) return 0;
    const total = PILLARS.reduce((s, p) => s + counts[p], 0);
    if (total === 0) return 0;
    return counts[pillar] / total;
  }

  /** Human-readable summary of what each feed has historically produced. */
  summary(): string {
    return Object.entries(this.data)
      .map(([domain, counts]) => {
        const total = PILLARS.reduce((s, p) => s + counts[p], 0);
        if (total === 0) return null;
        const breakdown = PILLARS
          .filter((p) => counts[p] > 0)
          .sort((a, b) => counts[b] - counts[a])
          .map((p) => `${p}:${counts[p]}`)
          .join('+');
        return `${domain}(${breakdown})`;
      })
      .filter(Boolean)
      .join('  ');
  }
}

// ── Scout class ───────────────────────────────────────────────────────────────
export class Scout {
  private prisma:      PrismaClient;
  private log:         (msg: string) => void;

  /**
   * Per-run state — persists across multiple Scout dispatches within a single
   * pipeline run.  Split into two sets so Round 1 URLs never block Tier 1/2
   * feeds in subsequent underquota / fallback dispatches.
   *
   * Reset when the Master dispatches mode: 'round_1'.
   *
   *   round1TriagedUrls     — URLs evaluated during round_1 (Tier 2 feeds).
   *                           Used only by round_1 buildPool() calls.
   *   underquotaTriagedUrls — URLs evaluated during underquota / fallback
   *                           dispatches.  Shared across both of those modes
   *                           so the Scout never re-triages a Tier 1/3 URL
   *                           between consecutive underquota rounds, but is
   *                           never polluted by round_1 URLs.
   */
  private round1TriagedUrls:     Set<string> = new Set();
  private underquotaTriagedUrls: Set<string> = new Set();
  private memory:                FeedMemory  = new FeedMemory();

  constructor(prisma: PrismaClient, log: (msg: string) => void = console.log) {
    this.prisma = prisma;
    this.log    = log;
  }

  // ── DB helpers ───────────────────────────────────────────────────────────────

  private async isProcessed(url: string): Promise<boolean> {
    const existing = await this.prisma.processedUrl.findUnique({ where: { url } });
    return existing !== null;
  }

  async markProcessed(url: string): Promise<void> {
    await this.prisma.processedUrl.upsert({
      where:  { url },
      update: {},
      create: { url },
    });
  }

  // ── LLM triage ───────────────────────────────────────────────────────────────

  private async triageItem(title: string, summary: string): Promise<TriageResult> {
    const prompt = `You are the **Scout Agent** for a Japanese pop-culture newsroom. Your job is to analyze raw Japanese RSS feed items, extract the core facts, and provide accurate localization notes.

**INSTRUCTIONS:**
1. **Dynamic Categorization:** Read the raw RSS content and classify it into EXACTLY ONE of the following 5 pillars:
   - **Japanese Anime** — TV anime, anime films, OVAs, voice actors (seiyuu),
     anime studios, anime-original projects.
   - **Japanese Gaming** — video games (console/PC/mobile/arcade), game
     announcements, beta tests, esports, JRPGs, gacha, indie JP titles.
   - **Japanese Infotainment** — J-pop / K-pop in Japan, idol groups
     (AKB48, Sakurazaka46, Hello!Project, Johnny's), Oricon music charts,
     live concerts, J-drama, Japanese live-action films, variety shows,
     celebrity news, music video releases. NOT anime films — those go to Anime.
   - **Japanese Manga** — manga series (Shonen Jump, Magazine Pocket, etc.),
     manga authors, comic awards, manga-original projects, light novels.
   - **Japanese Toys/Collectibles** — figures (PVC/scale/Nendoroid),
     plamo/gunpla, prize figures, trading cards, gachapon, hobby merch,
     pre-order announcements, collectible toy news.
   *(If the article does not fit any of these, mark it as "REJECTED".)*

2. **Fact Extraction:** Extract the who, what, when, where, and why of the news.

3. **CRITICAL LOCALIZATION RULE:** Do NOT use literal translations for Japanese proper nouns (character names, game titles, anime titles, studio names). You must research or infer their official English localized names or standard Romaji.
   - *Example:* Do not translate [ネル ～コールサインダブルオー～] literally. Research it and provide the proper name: "Neru".

4. **Output Format:** Provide a section called \`[Translation Notes]\` explicitly listing the correct Romaji/English names for all key entities found in the article.

**RSS ITEM TO ANALYZE:**
Title: "${title}"
Summary: "${summary}"

**EXPECTED OUTPUT JSON:**
{
  "status": "APPROVED" | "REJECTED",
  "pillar": "Selected Pillar",
  "extracted_facts": "...",
  "translation_notes": "- ネル = Neru\\n- ..."
}

Respond ONLY with the JSON object.`;

    try {
      const raw = await chat(
        [{ role: 'user', content: prompt }],
        { temperature: 0, maxTokens: 400 }
      );

      const result = parseJsonResponse<{
        status: string;
        pillar: string;
        extracted_facts: string;
        translation_notes: string;
      }>(raw);

      if (result.status === 'REJECTED') {
        return { status: 'REJECTED', reason: 'LLM: not relevant to any pillar' };
      }

      const pillar = PILLAR_FROM_LABEL[result.pillar];
      if (!pillar) {
        return { status: 'PARSE_ERROR', reason: `Unknown pillar label: "${result.pillar}"` };
      }

      return {
        status: 'APPROVED',
        pillar,
        extracted_facts:   result.extracted_facts   || '',
        translation_notes: result.translation_notes || '',
      };
    } catch (err) {
      return { status: 'PARSE_ERROR', reason: `LLM/parse exception: ${(err as Error).message}` };
    }
  }

  // ── Build deduplicated pool ───────────────────────────────────────────────────

  /**
   * Fetch `feedUrls`, deduplicate, age-filter, remove already-processed/triaged
   * items, and return up to `maxItems` candidates ordered by the Fair-Source
   * Interleave algorithm.
   *
   * Pool construction:
   *   1. All feeds are fetched concurrently.
   *   2. Raw items are deduplicated by URL.
   *   3. fairPillarInterleave() groups sources by predicted dominant pillar
   *      (from FeedMemory) and round-robins across pillar lanes (rare-first),
   *      then within each lane across sources. The pool head spans all 5
   *      predicted pillars before any single source is repeated.
   *   4. Age filter and processed/triaged URL pruning are applied to the
   *      interleaved order (preserving it).
   *   5. The first `maxItems` survivors are returned — order is intentional,
   *      no final shuffle (the interleaved order IS the fairness guarantee).
   *
   * @param feedUrls    - Which RSS feeds to fetch
   * @param ageDays     - Maximum article age in days
   * @param rejectedUrls - URLs the caller has explicitly ruled out
   * @param triagedUrls  - URLs already sent to the LLM this run (skip them)
   * @param maxItems    - Cap on how many items to return
   */
  private async buildPool(
    feedUrls:     string[],
    ageDays:      number,
    rejectedUrls: Set<string>,
    triagedUrls:  Set<string>,
    memory:       FeedMemory,
    maxItems:     number = FRESH_POOL_SIZE
  ): Promise<PoolItem[]> {
    // ── Step 1: Fetch all feeds concurrently (with per-feed fallback) ─────────
    const feedResults = await Promise.allSettled(
      feedUrls.map((url) => fetchFeed(url, 'anime', FEED_FALLBACK_MAP.get(url)))
    );

    // ── Step 2: Collect and deduplicate raw items ─────────────────────────────
    const rawItems: PoolItem[] = [];
    const seenLinks = new Set<string>();

    for (const result of feedResults) {
      if (result.status !== 'fulfilled') continue;
      for (const item of result.value) {
        if (!seenLinks.has(item.link)) {
          seenLinks.add(item.link);
          rawItems.push({
            title:      item.title,
            link:       item.link,
            summary:    item.summary,
            pubDate:    item.pubDate,
            sourceFeed: item.sourceFeed,
          });
        }
      }
    }

    // ── Step 3: Pillar-aware fair interleave ──────────────────────────────────
    // Group sources by their predicted dominant pillar (from FeedMemory),
    // then round-robin across pillar lanes (rare-first) and within each
    // lane across sources. Result: pool head spans all 5 predicted pillars.
    const interleaved = fairPillarInterleave(rawItems, memory);

    const sourceCount = new Set(rawItems.map((i) => i.sourceFeed)).size;
    const laneSummary = new Map<string, number>();
    for (const it of rawItems) {
      const lane = memory.dominantPillar(it.sourceFeed) ?? 'unknown';
      laneSummary.set(lane, (laneSummary.get(lane) ?? 0) + 1);
    }
    const laneStr = [...laneSummary.entries()]
      .map(([lane, n]) => `${lane}:${n}`)
      .join('  ');
    this.log(
      `[Scout] Pillar-fair interleave — ${interleaved.length} items across ${sourceCount} source(s) | lanes: ${laneStr}`
    );

    // ── Step 4: Age filter (preserves interleaved order) ─────────────────────
    const cutoff = Date.now() - ageDays * 24 * 60 * 60 * 1000;
    const aged   = interleaved.filter((item) =>
      !item.pubDate || new Date(item.pubDate).getTime() >= cutoff
    );

    const dropped = interleaved.length - aged.length;
    if (dropped > 0) {
      this.log(`[Scout] Age filter (${ageDays}d): ${dropped} stale items removed (${aged.length} remain)`);
    }

    // ── Step 5: Remove already-processed / triaged URLs ───────────────────────
    const unprocessed: PoolItem[] = [];
    for (const item of aged) {
      if (rejectedUrls.has(item.link)) continue;
      if (triagedUrls.has(item.link))  continue;
      const seen = await this.isProcessed(item.link);
      if (seen) continue;
      unprocessed.push(item);
    }

    // Return up to maxItems — interleaved order preserved intentionally
    return unprocessed.slice(0, maxItems);
  }

  /**
   * Build a deduplicated, bucket-aware list of Tier 3 (Fallback) feed URLs.
   *
   * Tier 3 is the broadest possible net — it combines EVERY feed available:
   *   • PRIORITY_FEEDS   (Tier 2 — general mixed-topic)
   *   • All RSS_FEEDS     (Tier 1 — hyper-specific subpillar branches)
   *
   * All feeds are deduplicated and sorted descending by FeedMemory usefulness
   * score so feeds with historical affinity for still-missing pillars are
   * fetched first. Feeds with no history score 0.5 (neutral).
   *
   * Using the extended 14-day age window (AGE_RETRY_DAYS) means this sweep
   * also surfaces older articles that weren't fresh enough for Round 1 or
   * Underquota — the "historical pool" element described in the spec.
   *
   * @param buckets - Current pillar fill counts (used for score calculation)
   * @param memory  - Empirical feed memory
   */
  private fallbackFeedUrls(
    buckets: Record<Pillar, ScoutItem[]>,
    memory:  FeedMemory
  ): string[] {
    const seen = new Set<string>();
    const entries: { url: string; score: number }[] = [];

    const addUrl = (url: string) => {
      if (seen.has(url)) return;
      seen.add(url);
      let domain = url;
      try { domain = new URL(url).hostname; } catch { /* keep raw */ }
      entries.push({ url, score: memory.score(domain, buckets) });
    };

    // Include Tier 1 (subpillar-specific) feeds first — already exhausted by
    // underquota rounds, but the 14-day window may surface older items.
    for (const pillar of PILLARS) {
      for (const url of RSS_FEEDS[pillar as Pillar]) addUrl(url);
    }

    // Include Tier 2 (general/mixed-topic) feeds — their items were triaged in
    // round1TriagedUrls (a separate set from underquotaTriagedUrls), so items
    // not consumed in Round 1 are still eligible here.
    for (const feed of PRIORITY_FEEDS) addUrl(feed.url);

    // Sort descending by usefulness — feeds strong in open pillars come first
    entries.sort((a, b) => b.score - a.score);

    this.log(
      `[Scout] Tier 3 Fallback feed pool (${entries.length} feeds): ` +
      entries.map((e) => {
        let domain = e.url;
        try { domain = new URL(e.url).hostname; } catch { /* keep raw */ }
        return `${domain}(${e.score.toFixed(2)})`;
      }).join(', ')
    );

    return entries.map((e) => e.url);
  }

  // ── Feed selection helpers ────────────────────────────────────────────────────

  /**
   * Return the RSS_FEEDS URLs for the specified missing pillar labels.
   * Falls back to all RSS_FEEDS if none of the labels resolve to a known pillar
   * or the resolved pillars have no dedicated feeds configured.
   */
  private getPillarFeeds(missingPillarLabels: string[]): string[] {
    const missingPillars = missingPillarLabels
      .map((label) => PILLAR_FROM_LABEL[label])
      .filter((p): p is Pillar => Boolean(p));

    const seen = new Set<string>();
    const urls: string[] = [];

    for (const pillar of missingPillars) {
      for (const url of RSS_FEEDS[pillar as Pillar]) {
        if (!seen.has(url)) {
          seen.add(url);
          urls.push(url);
        }
      }
    }

    if (urls.length === 0) {
      // No dedicated feeds for these pillars — return all fallback feeds
      this.log('[Scout] No pillar-specific feeds found — using all fallback feeds');
      return this.getAllFallbackFeedUrls();
    }

    return urls;
  }

  /** Collect every URL from RSS_FEEDS (all pillars), deduped. */
  private getAllFallbackFeedUrls(): string[] {
    const seen = new Set<string>();
    const urls: string[] = [];
    for (const pillar of PILLARS) {
      for (const url of RSS_FEEDS[pillar as Pillar]) {
        if (!seen.has(url)) {
          seen.add(url);
          urls.push(url);
        }
      }
    }
    return urls;
  }

  /**
   * Build a virtual bucket map for feed scoring.
   *
   * Pillars in `missingSet` are treated as EMPTY (need = 1).
   * All other pillars are treated as FULL (need = 0).
   *
   * This causes FeedMemory.score() to strongly prefer feeds that
   * historically produce content for the missing pillars.
   */
  private buildScoringBuckets(missingSet: Set<Pillar>): Record<Pillar, ScoutItem[]> {
    const buckets: Record<Pillar, ScoutItem[]> = {
      anime: [], gaming: [], infotainment: [], manga: [], toys: [],
    };
    for (const pillar of PILLARS) {
      if (!missingSet.has(pillar)) {
        // Fill with dummy entries to signal "this pillar is satisfied"
        buckets[pillar] = new Array(MAX_CANDIDATES_PER_PILLAR).fill({
          title: '', link: '', summary: '', pillar,
        });
      }
    }
    return buckets;
  }

  // ── Bucket-aware triage ──────────────────────────────────────────────────────

  /**
   * Triage `pool` and return approved ScoutItems with **dynamic per-pillar
   * fill awareness**.
   *
   * Unlike the old triagePool(), this caps each pillar at MAX_CANDIDATES_PER_PILLAR
   * INTERNALLY so the Scout never wastes LLM calls on items destined for a full
   * bucket. The Master Orchestrator still does its own dedup/cap, but the Scout
   * stops pushing once each pillar is satisfied.
   *
   * Four critical behaviours:
   *
   *   1. **Local mutable buckets** — `localBuckets` mirrors current accepted
   *      counts and is what feeds into `memory.score()`. As gaming fills, the
   *      score for gaming-dominant feeds collapses to 0, demoting them past
   *      the USEFUL_SCORE_THRESHOLD into the fallback tier.
   *
   *   2. **Predictive skip** — items from sources with ≥70% historical
   *      affinity for an already-full pillar are dropped BEFORE the LLM call.
   *      Saves LLM cost; the LLM almost always agrees with strong source priors.
   *
   *   3. **Early termination** — when all 5 pillars hit
   *      MAX_CANDIDATES_PER_PILLAR (or all filterPillars are full), the loop
   *      breaks immediately. No more batches, no more LLM calls.
   *
   *   4. **Hard pillar cap** — even after LLM approval, items for full pillars
   *      are dropped (instead of being returned for the Master to discard).
   *
   * `scoringBuckets` is used as the INITIAL state. For round_1 it's all empty;
   * for underquota/fallback it's pre-filled to mark satisfied pillars.
   *
   * If `filterPillars` is non-empty, items outside that set are skipped and
   * never count toward fill state.
   */
  private async triageAll(
    pool:          PoolItem[],
    scoringBuckets: Record<Pillar, ScoutItem[]>,
    memory:        FeedMemory,
    triagedUrls:   Set<string>,
    roundLabel:    string,
    filterPillars?: Set<Pillar>
  ): Promise<ScoutItem[]> {
    const PREDICTIVE_SKIP_THRESHOLD = 0.7; // skip if source is ≥70% affinity for full pillar

    // Deep-copy scoringBuckets so we can mutate locally without polluting the caller.
    const localBuckets: Record<Pillar, ScoutItem[]> = {
      anime:        [...scoringBuckets.anime],
      gaming:       [...scoringBuckets.gaming],
      infotainment: [...scoringBuckets.infotainment],
      manga:        [...scoringBuckets.manga],
      toys:         [...scoringBuckets.toys],
    };

    /** Active pillars = the ones we're still trying to fill. */
    const activePillars: Pillar[] = filterPillars && filterPillars.size > 0
      ? PILLARS.filter((p) => filterPillars.has(p))
      : [...PILLARS];

    const allActiveFull = (): boolean =>
      activePillars.every((p) => localBuckets[p].length >= MAX_CANDIDATES_PER_PILLAR);

    const isPillarFull = (p: Pillar): boolean =>
      localBuckets[p].length >= MAX_CANDIDATES_PER_PILLAR;

    const results:   ScoutItem[] = [];
    let   remaining              = [...pool];
    let   batchNum               = 0;
    let   predictiveSkipTotal    = 0;

    while (remaining.length > 0 && !allActiveFull()) {
      // ── Adaptive batch size ──────────────────────────────────────────────
      // Sum remaining slots across active pillars × overshoot factor; clamp
      // to [MIN_BATCH_SIZE, MAX_BATCH_SIZE].  Wide batches early when slots
      // are wide-open (50 slots → batch of 20), narrow batches near the
      // finish line so we don't overshoot a near-full bucket.
      const remainingSlots = activePillars.reduce(
        (sum, p) => sum + Math.max(0, MAX_CANDIDATES_PER_PILLAR - localBuckets[p].length),
        0
      );
      const desiredBatch = Math.max(
        MIN_BATCH_SIZE,
        Math.min(MAX_BATCH_SIZE, remainingSlots * ADAPTIVE_OVERSHOOT)
      );

      // ── Score remaining items using DYNAMIC localBuckets ─────────────────
      const scored = remaining.map((item) => ({
        item,
        score: memory.score(item.sourceFeed, localBuckets),
      }));

      const preferred = scored
        .filter((s) => s.score >= USEFUL_SCORE_THRESHOLD)
        .sort((a, b) => b.score - a.score);

      const fallback = scored
        .filter((s) => s.score < USEFUL_SCORE_THRESHOLD)
        .sort((a, b) => b.score - a.score);

      // ── Predictive skip: drop items whose source overwhelmingly produces ─
      //    content for an already-full pillar.  Skipped items still get
      //    marked as triaged so they don't reappear in later dispatches.
      const candidates = [...preferred, ...fallback];
      const batch:       PoolItem[] = [];
      const skippedHere: PoolItem[] = [];

      for (const { item } of candidates) {
        if (batch.length >= desiredBatch) break;

        // Find pillars this source has strong affinity for AND that are full
        let predictiveSkip = false;
        for (const p of activePillars) {
          if (!isPillarFull(p)) continue;
          if (memory.pillarShare(item.sourceFeed, p) >= PREDICTIVE_SKIP_THRESHOLD) {
            predictiveSkip = true;
            break;
          }
        }

        if (predictiveSkip) {
          skippedHere.push(item);
        } else {
          batch.push(item);
        }
      }

      // Items we examined this batch (whether picked or pre-skipped) are
      // removed from `remaining` so we don't reconsider them
      const handledLinks = new Set([
        ...batch.map((i) => i.link),
        ...skippedHere.map((i) => i.link),
      ]);
      remaining = remaining.filter((i) => !handledLinks.has(i.link));

      // Mark predictive skips as triaged immediately so retries don't fetch them
      for (const item of skippedHere) triagedUrls.add(item.link);
      predictiveSkipTotal += skippedHere.length;

      // If predictive skip drained the candidates and batch is empty, loop again
      if (batch.length === 0 && skippedHere.length > 0) {
        this.log(
          `[Scout] ${roundLabel} — predictive skip dropped ${skippedHere.length} item(s) ` +
          `(source ≥${(PREDICTIVE_SKIP_THRESHOLD * 100).toFixed(0)}% affinity for full pillar)`
        );
        continue;
      }
      if (batch.length === 0) break;

      batchNum++;

      const fillState = activePillars
        .map((p) => `${p}:${localBuckets[p].length}/${MAX_CANDIDATES_PER_PILLAR}`)
        .join(' ');
      const skipNote = skippedHere.length > 0
        ? ` | predictive-skip:${skippedHere.length}`
        : '';

      this.log(
        `[Scout] ${roundLabel} — Batch ${batchNum} (${batch.length} items, adaptive=${desiredBatch}${skipNote}, ${remaining.length} remaining) | ${fillState}`
      );

      // Mark all batch items as triaged BEFORE the LLM call
      for (const item of batch) triagedUrls.add(item.link);

      const triageResults = await Promise.all(
        batch.map((item) => this.triageItem(item.title, item.summary))
      );

      let accepted = 0, rejected = 0, skipped = 0, errors = 0, capped = 0;

      for (let j = 0; j < triageResults.length; j++) {
        const result = triageResults[j];
        const item   = batch[j];

        if (result.status === 'REJECTED') {
          rejected++;
          this.log(`[Scout] ✗ REJECTED  — ${result.reason} | "${item.title}"`);
          continue;
        }

        if (result.status === 'PARSE_ERROR') {
          errors++;
          this.log(`[Scout] ✗ ERROR     — ${result.reason} | "${item.title}"`);
          continue;
        }

        // APPROVED — update empirical memory for ALL approved items
        memory.record(item.sourceFeed, result.pillar);

        // If a pillar filter is active, skip items outside the target set
        if (filterPillars && filterPillars.size > 0 && !filterPillars.has(result.pillar)) {
          skipped++;
          this.log(
            `[Scout] ~ SKIP     [${result.pillar}] not in target pillars | "${item.title}"`
          );
          continue;
        }

        // Hard pillar cap — drop if this pillar is already full locally
        if (isPillarFull(result.pillar)) {
          capped++;
          this.log(
            `[Scout] ~ FULL     [${result.pillar}] (${localBuckets[result.pillar].length}/${MAX_CANDIDATES_PER_PILLAR}) | "${item.title}"`
          );
          continue;
        }

        const scoutItem: ScoutItem = {
          title:            item.title,
          link:             item.link,
          summary:          item.summary,
          pillar:           result.pillar,
          translationNotes: result.translation_notes,
        };
        localBuckets[result.pillar].push(scoutItem);
        results.push(scoutItem);
        accepted++;
        this.log(
          `[Scout] ✓ ACCEPTED  [${result.pillar}] (${localBuckets[result.pillar].length}/${MAX_CANDIDATES_PER_PILLAR}) ` +
          `[${item.sourceFeed}] | "${item.title}"`
        );
      }

      this.log(
        `[Scout] Batch ${batchNum} done — ✓${accepted} ✗${rejected} skip:${skipped} cap:${capped} err:${errors} | ${activePillars.map((p) => `${p}:${localBuckets[p].length}`).join(' ')}`
      );
    }

    if (allActiveFull()) {
      this.log(
        `[Scout] ${roundLabel} — All active pillars satisfied. Stopping early ` +
        `(${remaining.length} item(s) untouched, ${predictiveSkipTotal} predictively skipped).`
      );
    } else if (predictiveSkipTotal > 0) {
      this.log(
        `[Scout] ${roundLabel} — total predictive skips: ${predictiveSkipTotal} (LLM calls saved)`
      );
    }

    return results;
  }

  // ── Main run ─────────────────────────────────────────────────────────────────

  /**
   * Execute one Scout dispatch as directed by the Master Orchestrator.
   *
   * The Scout fetches the appropriate feeds, runs LLM triage, and returns
   * every approved topic.  It does NOT enforce quota caps — that is the
   * Master's job.  The Master calls run() multiple times within a single
   * pipeline run; per-run state (triagedUrls, FeedMemory) persists across
   * calls so URLs are never evaluated twice.
   */
  async run(
    payload:      ScoutPayload    = { mode: 'round_1' },
    rejectedUrls: Set<string>     = new Set()
  ): Promise<ScoutItem[]> {
    const { mode, missing_pillars = [] } = payload;

    // ── Per-run state reset (round_1 only) ────────────────────────────────────
    if (mode === 'round_1') {
      this.round1TriagedUrls     = new Set();
      this.underquotaTriagedUrls = new Set();
      this.memory                = new FeedMemory();
      await this.memory.load(this.log);
      const memSummary = this.memory.summary();
      if (memSummary) this.log(`[Scout] Historical feed memory: ${memSummary}`);
    }

    this.log(
      `[Scout] Dispatched — mode: ${mode}` +
      (missing_pillars.length ? ` | targeting: ${missing_pillars.join(', ')}` : '')
    );

    // ── Determine feed URLs, pool size, age window, and pillar filter ─────────
    let feedUrls:      string[];
    let ageDays:       number;
    let maxItems:      number;
    let filterPillars: Set<Pillar> | undefined;
    let roundLabel:    string;

    if (mode === 'round_1') {
      // ── Tier 2: Preferred — broad scrape from general mixed-topic feeds ──────
      feedUrls      = PRIORITY_FEEDS.map((f) => f.url);
      ageDays       = AGE_LIMIT_DAYS;
      maxItems      = FRESH_POOL_SIZE;
      filterPillars = undefined; // accept all pillars
      roundLabel    = 'Round 1 [Tier 2 — Preferred]';

    } else if (mode === 'underquota_protocol') {
      // ── Tier 1: Priority — sniper fetch from subpillar-specific branches ─────
      feedUrls   = this.getPillarFeeds(missing_pillars);
      ageDays    = AGE_LIMIT_DAYS;
      maxItems   = RETRY_POOL_SIZE;
      roundLabel = `Underquota [Tier 1 — Priority] (${missing_pillars.join(', ')})`;
      // Strictly filter results to the missing pillars only (doc requirement)
      filterPillars = new Set(
        missing_pillars
          .map((label) => PILLAR_FROM_LABEL[label])
          .filter((p): p is Pillar => Boolean(p))
      );

    } else {
      // ── Tier 3: Fallback — wide sweep, all RSS_FEEDS scored by memory ─────────
      const missingSet = new Set(
        missing_pillars
          .map((label) => PILLAR_FROM_LABEL[label])
          .filter((p): p is Pillar => Boolean(p))
      );
      const scoringBucketsForRanking = this.buildScoringBuckets(missingSet);
      feedUrls      = this.fallbackFeedUrls(scoringBucketsForRanking, this.memory);
      ageDays       = AGE_RETRY_DAYS;
      maxItems      = RETRY_POOL_SIZE;
      roundLabel    = `Fallback [Tier 3] (${missing_pillars.join(', ')})`;
      filterPillars = missingSet.size > 0 ? missingSet : undefined;
    }

    // ── Select the correct per-tier triaged-URL set ───────────────────────────
    //
    // round_1            → only round1TriagedUrls (Tier 2 feeds exclusively)
    // underquota_protocol → only underquotaTriagedUrls (Tier 1 feeds; Tier 2
    //                       items remain eligible since round1TriagedUrls is
    //                       separate — but Tier 1 feeds don't overlap with Tier 2)
    // fallback_protocol  → BOTH sets merged, because Tier 3 now includes ALL
    //                       feeds (Tier 1 + Tier 2). Without the merge, items
    //                       triaged in Round 1 (round1TriagedUrls) would slip
    //                       back through buildPool's triaged-URL filter.
    const triagedUrls: Set<string> = mode === 'round_1'
      ? this.round1TriagedUrls
      : mode === 'fallback_protocol'
        ? new Set([...this.round1TriagedUrls, ...this.underquotaTriagedUrls])
        : this.underquotaTriagedUrls;

    // ── Build deduplicated, age-filtered pool ─────────────────────────────────
    this.log(
      `[Scout] Building pool from ${feedUrls.length} feed(s) ` +
      `(${ageDays}-day window, cap: ${maxItems})...`
    );

    const pool = await this.buildPool(
      feedUrls, ageDays, rejectedUrls, triagedUrls, this.memory, maxItems
    );

    if (pool.length === 0) {
      this.log(`[Scout] No new items found — handing 0 topics to Master.`);
      await this.memory.save(this.log);
      return [];
    }

    this.log(`[Scout] Pool: ${pool.length} items. Starting triage...`);

    // ── Build scoring buckets for feed prioritisation ─────────────────────────
    let scoringBuckets: Record<Pillar, ScoutItem[]>;
    if (mode === 'round_1') {
      // All pillars equally needed — empty buckets → score driven purely by history
      scoringBuckets = { anime: [], gaming: [], infotainment: [], manga: [], toys: [] };
    } else {
      const missingSet = new Set(
        missing_pillars
          .map((label) => PILLAR_FROM_LABEL[label])
          .filter((p): p is Pillar => Boolean(p))
      );
      scoringBuckets = this.buildScoringBuckets(missingSet);
    }

    // ── Triage the pool (no quota caps — Master does the capping) ─────────────
    const results = await this.triageAll(
      pool, scoringBuckets, this.memory, triagedUrls, roundLabel, filterPillars
    );

    await this.memory.save(this.log);

    this.log(
      `[Scout] Handover complete — ${results.length} topic(s) returned to Master.` +
      (this.memory.summary() ? ` | Feed memory: ${this.memory.summary()}` : '')
    );

    return results;
  }
}
