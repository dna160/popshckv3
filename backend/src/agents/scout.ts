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
import { fetchFeed, RSS_FEEDS, PRIORITY_FEEDS } from '../services/rss';
import { chat, parseJsonResponse } from '../services/llm';
import type { Pillar, ScoutItem } from '../../../shared/types';
import { PILLARS, PILLAR_LABELS } from '../../../shared/types';

// ── Constants ────────────────────────────────────────────────────────────────
const MAX_CANDIDATES_PER_PILLAR = 10;  // used by FeedMemory.score() to compute need()
const FRESH_POOL_SIZE           = 100; // items pulled from PRIORITY_FEEDS on round_1
const RETRY_POOL_SIZE           = 50;  // items pulled from fallback feeds per underquota/fallback dispatch
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
   - Japanese Anime
   - Japanese Gaming
   - Japanese Infotainment
   - Japanese Manga
   - Japanese Toys/Collectibles
   *(If the article does not fit any of these, mark it as "REJECTED").*

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

  // ── Core triage loop ─────────────────────────────────────────────────────────

  private async triagePool(
    pool: PoolItem[],
    buckets: Record<Pillar, ScoutItem[]>,
    memory: FeedMemory,
    triagedUrls: Set<string>,  // populated here so retries skip already-triaged items
    roundLabel: string
  ): Promise<void> {
    const allFull = () => PILLARS.every((p) => buckets[p].length >= MAX_CANDIDATES_PER_PILLAR);
    // `let` because we reassign via .filter() when pulling the batch
    let remaining = [...pool];
    let batchNum = 0;

    while (remaining.length > 0 && !allFull()) {
      const fullPillars = PILLARS.filter((p) => buckets[p].length >= MAX_CANDIDATES_PER_PILLAR);
      const openPillars = PILLARS.filter((p) => buckets[p].length < MAX_CANDIDATES_PER_PILLAR);

      // ── Bucket-aware batch construction ──────────────────────────────────
      //
      // Score every remaining item given the CURRENT bucket state, then split
      // into two tiers:
      //
      //   Preferred — feeds scoring ≥ USEFUL_SCORE_THRESHOLD:
      //     These feeds have meaningful historical affinity for at least one
      //     open pillar. Use them first.
      //
      //   Fallback  — feeds scoring < USEFUL_SCORE_THRESHOLD:
      //     These feeds predominantly produce content for pillar(s) that are
      //     already full. Only pulled into the batch when the preferred pool
      //     cannot fill the full BATCH_SIZE.
      //
      // This guarantees that once gaming (for example) is full, the Scout
      // exhausts all feeds with non-gaming affinity before touching 4Gamer
      // or other gaming-heavy sources.  Even then those sources may contain
      // the occasional off-pillar article, so they are never skipped entirely.
      const scored = remaining.map((item) => ({
        item,
        score: memory.score(item.sourceFeed, buckets),
      }));

      const preferred = scored
        .filter((s) => s.score >= USEFUL_SCORE_THRESHOLD)
        .sort((a, b) => b.score - a.score);

      const fallback = scored
        .filter((s) => s.score < USEFUL_SCORE_THRESHOLD)
        .sort((a, b) => b.score - a.score);

      const batchScored = [...preferred, ...fallback].slice(0, BATCH_SIZE);
      const batch       = batchScored.map((s) => s.item);

      // Remove the selected items from the remaining pool
      const batchLinks = new Set(batch.map((i) => i.link));
      remaining = remaining.filter((i) => !batchLinks.has(i.link));

      batchNum++;

      // ── Batch composition log ─────────────────────────────────────────────
      const prefCount = batchScored.filter((s) => s.score >= USEFUL_SCORE_THRESHOLD).length;
      const fbCount   = batchScored.length - prefCount;

      if (fullPillars.length > 0) {
        const tierNote = fbCount > 0
          ? `${prefCount} preferred + ${fbCount} fallback (full: [${fullPillars.join(', ')}])`
          : `${prefCount} preferred`;
        this.log(
          `[Scout] ${roundLabel} — Batch ${batchNum} (${batch.length} items): ${tierNote}` +
          ` | open: [${openPillars.join(', ')}] | ${remaining.length} remaining`
        );
      } else {
        this.log(
          `[Scout] ${roundLabel} — Batch ${batchNum} (${batch.length} items, ${remaining.length} remaining)`
        );
      }

      // Mark all batch items as triaged BEFORE the LLM call so retries
      // never re-evaluate the same URL regardless of outcome
      for (const item of batch) triagedUrls.add(item.link);

      const results = await Promise.all(
        batch.map((item) => this.triageItem(item.title, item.summary))
      );

      let accepted = 0, rejected = 0, errors = 0, dropped = 0;

      for (let j = 0; j < results.length; j++) {
        const result = results[j];
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

        // APPROVED — update empirical memory regardless of bucket state
        memory.record(item.sourceFeed, result.pillar);

        const bucket = buckets[result.pillar];
        if (bucket.length < MAX_CANDIDATES_PER_PILLAR) {
          bucket.push({
            title:            item.title,
            link:             item.link,
            summary:          item.summary,
            pillar:           result.pillar,
            translationNotes: result.translation_notes,
          });
          accepted++;
          this.log(
            `[Scout] ✓ ACCEPTED  [${result.pillar}] (${bucket.length}/${MAX_CANDIDATES_PER_PILLAR}) ` +
            `[${item.sourceFeed}] | "${item.title}"`
          );
        } else {
          dropped++;
          this.log(`[Scout] ~ FULL [${result.pillar}] [${item.sourceFeed}] | "${item.title}"`);
        }
      }

      const state = PILLARS.map((p) => `${p}:${buckets[p].length}`).join('  ');
      this.log(
        `[Scout] Batch ${batchNum} — ✓${accepted} ✗${rejected} err:${errors} drop:${dropped} | ${state}`
      );
    }
  }

  // ── Build deduplicated pool ───────────────────────────────────────────────────

  /**
   * Fetch `feedUrls`, deduplicate, age-filter, remove already-processed/triaged
   * items, and return up to `maxItems` candidates (freshest-first, shuffled).
   *
   * @param feedUrls    - Which RSS feeds to fetch (PRIORITY on Round 1,
   *                      fallback RSS_FEEDS on Round 2+)
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
    maxItems:     number = FRESH_POOL_SIZE
  ): Promise<PoolItem[]> {
    // Fetch all feeds concurrently; tag each item with 'anime' as a dummy pillar
    // (the Scout's LLM triage assigns the real pillar — this field is unused here)
    const feedResults = await Promise.allSettled(
      feedUrls.map((url) => fetchFeed(url, 'anime'))
    );

    const rawItems: PoolItem[] = [];
    const seenLinks = new Set<string>();
    for (const result of feedResults) {
      if (result.status === 'fulfilled') {
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
    }

    const sorted = rawItems.sort((a, b) => {
      const ta = a.pubDate ? new Date(a.pubDate).getTime() : 0;
      const tb = b.pubDate ? new Date(b.pubDate).getTime() : 0;
      return tb - ta;
    });

    const cutoff = Date.now() - ageDays * 24 * 60 * 60 * 1000;
    const aged   = sorted.filter((item) =>
      !item.pubDate || new Date(item.pubDate).getTime() >= cutoff
    );

    const dropped = sorted.length - aged.length;
    if (dropped > 0) {
      this.log(`[Scout] Age filter (${ageDays}d): ${dropped} stale items removed (${aged.length} remain)`);
    }

    const unprocessed: PoolItem[] = [];
    for (const item of aged) {
      if (rejectedUrls.has(item.link)) continue;
      if (triagedUrls.has(item.link))  continue; // already evaluated this run — skip
      const seen = await this.isProcessed(item.link);
      if (seen) continue;
      unprocessed.push(item);
    }

    // Shuffle the freshest slice up to the cap — hard stop at maxItems
    const topFresh = unprocessed.slice(0, maxItems);
    return shuffle(topFresh);
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
    for (const url of PRIORITY_FEEDS) addUrl(url);

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

  // ── No-cap triage ─────────────────────────────────────────────────────────────

  /**
   * Triage every item in `pool` and return ALL approved ScoutItems.
   *
   * Unlike the old triagePool(), this method enforces NO quota cap —
   * that responsibility belongs exclusively to the Master Orchestrator.
   *
   * Feed scoring still uses `scoringBuckets` so the preferred/fallback
   * tier logic prioritises feeds relevant to the missing pillars.
   *
   * If `filterPillars` is provided (non-empty), only items whose LLM-assigned
   * pillar is in that set are included in the returned array.  FeedMemory is
   * still updated for ALL approved items regardless of the filter.
   */
  private async triageAll(
    pool:          PoolItem[],
    scoringBuckets: Record<Pillar, ScoutItem[]>,
    memory:        FeedMemory,
    triagedUrls:   Set<string>,
    roundLabel:    string,
    filterPillars?: Set<Pillar>
  ): Promise<ScoutItem[]> {
    const results:   ScoutItem[] = [];
    let   remaining              = [...pool];
    let   batchNum               = 0;

    while (remaining.length > 0) {
      // ── Score remaining items using feed memory + current scoring buckets ──
      const scored = remaining.map((item) => ({
        item,
        score: memory.score(item.sourceFeed, scoringBuckets),
      }));

      const preferred = scored
        .filter((s) => s.score >= USEFUL_SCORE_THRESHOLD)
        .sort((a, b) => b.score - a.score);

      const fallback = scored
        .filter((s) => s.score < USEFUL_SCORE_THRESHOLD)
        .sort((a, b) => b.score - a.score);

      const batchScored = [...preferred, ...fallback].slice(0, BATCH_SIZE);
      const batch       = batchScored.map((s) => s.item);
      const batchLinks  = new Set(batch.map((i) => i.link));
      remaining = remaining.filter((i) => !batchLinks.has(i.link));

      batchNum++;

      const prefCount = batchScored.filter((s) => s.score >= USEFUL_SCORE_THRESHOLD).length;
      const fbCount   = batchScored.length - prefCount;
      const tierNote  = fbCount > 0
        ? `${prefCount} preferred + ${fbCount} fallback`
        : `${prefCount} preferred`;

      this.log(
        `[Scout] ${roundLabel} — Batch ${batchNum} (${batch.length} items, ${tierNote}, ${remaining.length} remaining)`
      );

      // Mark all batch items as triaged BEFORE the LLM call
      for (const item of batch) triagedUrls.add(item.link);

      const triageResults = await Promise.all(
        batch.map((item) => this.triageItem(item.title, item.summary))
      );

      let accepted = 0, rejected = 0, skipped = 0, errors = 0;

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

        results.push({
          title:            item.title,
          link:             item.link,
          summary:          item.summary,
          pillar:           result.pillar,
          translationNotes: result.translation_notes,
        });
        accepted++;
        this.log(
          `[Scout] ✓ ACCEPTED  [${result.pillar}] [${item.sourceFeed}] | "${item.title}"`
        );
      }

      this.log(
        `[Scout] Batch ${batchNum} done — ✓${accepted} ✗${rejected} skip:${skipped} err:${errors}`
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
      feedUrls      = PRIORITY_FEEDS;
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
      feedUrls, ageDays, rejectedUrls, triagedUrls, maxItems
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
