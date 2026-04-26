/**
 * Underquota Protocol — Tier 1 Priority-Feed Triage
 *
 * A specialised sub-agent of the Scout, activated directly by the Master
 * Orchestrator when one or more pillars fail to reach quota after Round 1.
 *
 * Responsibilities:
 *   • Pull items exclusively from PRIORITY_FEEDS that are tagged for the
 *     deficit pillar(s).  These are curated, subpillar-specific feeds
 *     (e.g. a feed tagged [manga] will only surface manga stories).
 *   • Run a pillar-focused triage prompt — the LLM knows which pillars
 *     are underquota so it can prioritise accordingly.
 *   • Track its own triagedUrls set so consecutive underquota rounds
 *     never re-evaluate the same item.
 *   • Cap each pillar internally so the LLM is never called on items
 *     destined for a full bucket (parity with Scout's triageAll).
 *   • Return ALL approved ScoutItems to the Master; quota-capping is the
 *     Master's responsibility for safety.
 *
 * Pool cap : UNDERQUOTA_POOL_SIZE = 50
 * Age window: AGE_LIMIT_DAYS = 14
 * Batch size: ADAPTIVE — scales with remaining slots, capped MAX_BATCH_SIZE
 */

import path from 'path';
import fs   from 'fs/promises';
import { PrismaClient }            from '@prisma/client';
import { fetchFeed, PRIORITY_FEEDS, FEED_FALLBACK_MAP } from '../services/rss';
import { chat, parseJsonResponse }  from '../services/llm';
import { PILLARS }                  from '../shared/types';
import type { Pillar, ScoutItem }   from '../shared/types';

// ── Constants ─────────────────────────────────────────────────────────────────
const UNDERQUOTA_POOL_SIZE       = 50;
const MIN_BATCH_SIZE             = 4;   // floor for adaptive batching
const MAX_BATCH_SIZE             = 20;  // ceiling — keeps LLM concurrency bounded
const ADAPTIVE_OVERSHOOT         = 2;   // batch = remaining_slots × overshoot
const AGE_LIMIT_DAYS             = 14;  // under-served pillars often have older items still relevant
const MAX_CANDIDATES_PER_PILLAR  = 10;
const PREDICTIVE_SKIP_THRESHOLD  = 0.7; // skip LLM if source ≥70% affinity for full pillar
const MEMORY_FILE                = path.join(process.cwd(), 'data', 'feed-memory.json');

// ── Lightweight FeedMemory reader (read-only, shared file with Scout) ────────
type PillarCounts   = Record<Pillar, number>;
type FeedMemoryData = Record<string, PillarCounts>;

async function loadFeedMemory(): Promise<FeedMemoryData> {
  try {
    const raw = await fs.readFile(MEMORY_FILE, 'utf-8');
    return JSON.parse(raw) as FeedMemoryData;
  } catch {
    return {};
  }
}

function dominantPillarOf(domain: string, mem: FeedMemoryData): Pillar | null {
  const counts = mem[domain];
  if (!counts) return null;
  let max = 0;
  let dom: Pillar | null = null;
  for (const p of PILLARS) {
    if (counts[p] > max) { max = counts[p]; dom = p; }
  }
  return max > 0 ? dom : null;
}

function pillarShareOf(domain: string, pillar: Pillar, mem: FeedMemoryData): number {
  const counts = mem[domain];
  if (!counts) return 0;
  const total = PILLARS.reduce((s, p) => s + counts[p], 0);
  return total === 0 ? 0 : counts[pillar] / total;
}

// ── Confidence weighting for sorting ─────────────────────────────────────────
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

/** Lookup a source hostname's confidence level based on PRIORITY_FEEDS config. */
const SOURCE_CONFIDENCE_MAP = new Map<string, Confidence>();
for (const feed of PRIORITY_FEEDS) {
  try {
    const host = new URL(feed.url).hostname;
    SOURCE_CONFIDENCE_MAP.set(host, feed.confidence);
    if (feed.fallback) {
      const fbHost = new URL(feed.fallback).hostname;
      // Use the lower confidence of primary/fallback so fallbacks don't claim primary's high
      if (!SOURCE_CONFIDENCE_MAP.has(fbHost)) {
        SOURCE_CONFIDENCE_MAP.set(fbHost, feed.confidence);
      }
    }
  } catch { /* keep going */ }
}

function sourceConfidence(domain: string): Confidence {
  return SOURCE_CONFIDENCE_MAP.get(domain) ?? 'unverified';
}

// ── Pillar label → internal key map ──────────────────────────────────────────
const PILLAR_FROM_LABEL: Record<string, Pillar> = {
  'Japanese Anime':             'anime',
  'Japanese Gaming':            'gaming',
  'Japanese Infotainment':      'infotainment',
  'Japanese Manga':             'manga',
  'Japanese Toys/Collectibles': 'toys',
  'Anime':  'anime',  'anime':  'anime',
  'Gaming': 'gaming', 'gaming': 'gaming',
  'Infotainment': 'infotainment', 'infotainment': 'infotainment',
  'Manga':  'manga',  'manga':  'manga',
  'Toys':   'toys',   'toys':   'toys',
  'Collectibles':          'toys',
  'Toys/Collectibles':     'toys',
  'Japanese Toys':         'toys',
  'Japanese Collectibles': 'toys',
  'Japanese Entertainment':  'infotainment',
  'Entertainment':           'infotainment',
  'Japanese Pop Culture':    'infotainment',
  'Japanese Comic':          'manga',
  'Comics':                  'manga',
  'Japanese Game':           'gaming',
  'Japanese Games':          'gaming',
  'Game': 'gaming',
};

const PILLAR_LABEL: Record<Pillar, string> = {
  anime:        'Japanese Anime',
  gaming:       'Japanese Gaming',
  infotainment: 'Japanese Infotainment',
  manga:        'Japanese Manga',
  toys:         'Japanese Toys/Collectibles',
};

/**
 * Pillar-Aware Fair Interleave (Underquota Variant)
 *
 * Groups items by source, sorts each newest-first, predicts each source's
 * dominant pillar from FeedMemory, then round-robins across pillar lanes
 * with target pillars drawn FIRST.
 *
 * Within each lane, sources are sorted by confidence (high → unverified)
 * so when targeting manga, chaosphere (proven 65% manga, confidence:high)
 * gets drawn before unverified sources within the manga lane.
 */
function fairPillarInterleave(
  items:         PoolItem[],
  memory:        FeedMemoryData,
  targetPillars: Pillar[]
): PoolItem[] {
  // Group by source, sort newest-first
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

  // Group sources by their dominant historical pillar
  type LaneKey = Pillar | 'unknown';
  const lanes = new Map<LaneKey, string[]>();
  for (const source of bySource.keys()) {
    const dominant = dominantPillarOf(source, memory);
    const key: LaneKey = dominant ?? 'unknown';
    if (!lanes.has(key)) lanes.set(key, []);
    lanes.get(key)!.push(source);
  }

  // ── Within-lane sort: confidence-first ─────────────────────────────────
  // Sources with proven track record (high confidence) get drawn before
  // unverified sources in the same lane.  Tie-break by total historical
  // volume so a 747-item ANN beats a 71-item chaosphere within the anime lane.
  for (const sources of lanes.values()) {
    sources.sort((a, b) => {
      const cA = confidenceWeight(sourceConfidence(a));
      const cB = confidenceWeight(sourceConfidence(b));
      if (cA !== cB) return cA - cB;
      const totalA = PILLARS.reduce((s, p) => s + (memory[a]?.[p] ?? 0), 0);
      const totalB = PILLARS.reduce((s, p) => s + (memory[b]?.[p] ?? 0), 0);
      return totalB - totalA;
    });
  }

  // Lane priority: target pillars first, THEN unknown, THEN off-target
  const targetSet = new Set<Pillar>(targetPillars);
  const otherPillars = PILLARS.filter((p) => !targetSet.has(p));
  const lanePriority: LaneKey[] = [...targetPillars, 'unknown', ...otherPillars];

  // Round-robin across lanes, then sources within each lane
  const result: PoolItem[] = [];
  const sourceCursor = new Map<LaneKey, number>();

  let progress = true;
  while (progress) {
    progress = false;
    for (const lane of lanePriority) {
      const sources = lanes.get(lane);
      if (!sources || sources.length === 0) continue;

      const start = sourceCursor.get(lane) ?? 0;
      let attempted = 0;
      let found = false;

      while (attempted < sources.length && !found) {
        const idx    = (start + attempted) % sources.length;
        const source = sources[idx];
        const bucket = bySource.get(source);
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

// ── Internal pool item type ───────────────────────────────────────────────────
interface PoolItem {
  title:      string;
  link:       string;
  summary:    string;
  pubDate?:   string;
  sourceFeed: string;
}

// ── UnderquotaProtocol ────────────────────────────────────────────────────────
export class UnderquotaProtocol {
  private prisma:      PrismaClient;
  private log:         (msg: string) => void;

  /**
   * Tracks every URL this instance has sent to the LLM across all underquota
   * rounds within a single pipeline run.
   */
  private triagedUrls: Set<string> = new Set();

  /**
   * FeedMemory cache — loaded ONCE per UnderquotaProtocol instance lifetime.
   * The orchestrator creates a fresh instance per pipeline run, so this is
   * effectively a per-run cache.  Without caching, loadFeedMemory() was being
   * called on every dispatch (5+ disk reads per run when deficit is bad).
   */
  private memoryCache: FeedMemoryData | null = null;

  constructor(prisma: PrismaClient, log: (msg: string) => void = console.log) {
    this.prisma = prisma;
    this.log    = log;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async getMemory(): Promise<FeedMemoryData> {
    if (this.memoryCache !== null) return this.memoryCache;
    this.memoryCache = await loadFeedMemory();
    return this.memoryCache;
  }

  private async isProcessed(url: string): Promise<boolean> {
    return (await this.prisma.processedUrl.findUnique({ where: { url } })) !== null;
  }

  /**
   * Return the URLs of every PRIORITY_FEEDS entry whose tags include at least
   * one of the target pillars, deduplicated and sorted by confidence
   * (high → medium → low → unverified).
   */
  private getFeedsForPillars(targetPillars: Pillar[]): string[] {
    const seen = new Set<string>();
    const urls: string[] = [];

    const candidates = [...PRIORITY_FEEDS]
      .filter((feed) => feed.tags.some((tag) => targetPillars.includes(tag)))
      .sort((a, b) => confidenceWeight(a.confidence) - confidenceWeight(b.confidence));

    for (const feed of candidates) {
      if (!seen.has(feed.url)) {
        seen.add(feed.url);
        urls.push(feed.url);
      }
    }

    return urls;
  }

  /**
   * Fetch `feedUrls`, deduplicate, age-filter, skip already-processed /
   * already-triaged URLs, and return up to UNDERQUOTA_POOL_SIZE candidates
   * ordered by the pillar-aware fair interleave algorithm.
   */
  private async buildPool(
    feedUrls:      string[],
    rejectedUrls:  Set<string>,
    memory:        FeedMemoryData,
    targetPillars: Pillar[]
  ): Promise<PoolItem[]> {
    const feedResults = await Promise.allSettled(
      feedUrls.map((url) => fetchFeed(url, 'anime', FEED_FALLBACK_MAP.get(url)))
    );

    const rawItems:  PoolItem[] = [];
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

    const interleaved = fairPillarInterleave(rawItems, memory, targetPillars);

    const sourceCount = new Set(rawItems.map((i) => i.sourceFeed)).size;
    const laneSummary = new Map<string, number>();
    for (const it of rawItems) {
      const lane = dominantPillarOf(it.sourceFeed, memory) ?? 'unknown';
      laneSummary.set(lane, (laneSummary.get(lane) ?? 0) + 1);
    }
    const laneStr = [...laneSummary.entries()]
      .map(([lane, n]) => `${lane}:${n}`)
      .join('  ');
    this.log(
      `[Underquota] Pillar-fair interleave — ${interleaved.length} items across ${sourceCount} source(s) | lanes: ${laneStr}`
    );

    const cutoff = Date.now() - AGE_LIMIT_DAYS * 24 * 60 * 60 * 1000;
    const aged   = interleaved.filter((item) =>
      !item.pubDate || new Date(item.pubDate).getTime() >= cutoff
    );

    const pool: PoolItem[] = [];
    for (const item of aged) {
      if (rejectedUrls.has(item.link))     continue;
      if (this.triagedUrls.has(item.link)) continue;
      if (await this.isProcessed(item.link)) continue;
      pool.push(item);
      if (pool.length >= UNDERQUOTA_POOL_SIZE) break;
    }

    return pool;
  }

  /**
   * Triage a single item with a pillar-aware underquota prompt.
   *
   * Prompt clarifies what counts as "infotainment" (J-pop, idols, drama,
   * films, music charts, celebrity coverage) since the LLM had been
   * defaulting to anime/gaming for ambiguous items.
   */
  private async triageItem(
    title:         string,
    summary:       string,
    targetPillars: Pillar[]
  ): Promise<
    | { status: 'APPROVED'; pillar: Pillar; extracted_facts: string; translation_notes: string }
    | { status: 'REJECTED';    reason: string }
    | { status: 'PARSE_ERROR'; reason: string }
  > {
    const targetLabels = targetPillars.map((p) => PILLAR_LABEL[p]).join(', ');

    const prompt = `You are the **Underquota Scout** for a Japanese pop-culture newsroom pipeline. \
The pipeline has not yet met its article quota for the pillars listed below. \
Your job is to classify this RSS item and extract key facts.

**UNDERQUOTA PILLARS (still need articles):** ${targetLabels}

**INSTRUCTIONS:**
1. Classify the item into EXACTLY ONE of the following 5 pillars:
   - **Japanese Anime** — TV anime, anime films, OVAs, voice actors (seiyuu),
     anime studios, anime-original projects.
   - **Japanese Gaming** — video games (console/PC/mobile/arcade), game
     announcements, beta tests, esports, JRPGs, gacha, indie JP titles.
   - **Japanese Infotainment** — J-pop / K-pop in Japan, idol groups
     (AKB48, Sakurazaka46, Hello!Project, Johnny's), Oricon music charts,
     live concerts, J-drama, Japanese films (live-action), variety shows,
     celebrity news, music video releases. NOT anime films — those go to Anime.
   - **Japanese Manga** — manga series (Shonen Jump, Magazine Pocket, etc.),
     manga authors, comic awards, manga-original projects, light novels.
   - **Japanese Toys/Collectibles** — figures (PVC/scale/Nendoroid),
     plamo/gunpla, prize figures, trading cards, gachapon, hobby merch,
     pre-order announcements, collectible toy news.

   If the item does not fit any pillar → REJECTED.
   Items that fit a non-underquota pillar are still accepted — the pipeline \
orchestrator will decide where to slot them.

2. Extract the who, what, when, where, and why of the news as concrete facts.

3. CRITICAL LOCALIZATION RULE: Do NOT use literal translations for Japanese \
proper nouns. Provide the official English or standard Romaji name.
   Example: 鬼滅の刃 → Kimetsu no Yaiba

**RSS ITEM TO ANALYSE:**
Title: "${title}"
Summary: "${summary}"

**OUTPUT JSON — respond with ONLY this JSON object, no prose:**
{
  "status": "APPROVED" | "REJECTED",
  "pillar": "Selected Pillar",
  "extracted_facts": "...",
  "translation_notes": "- 名前 = Name\\n- ..."
}`;

    try {
      const raw = await chat(
        [{ role: 'user', content: prompt }],
        { temperature: 0, maxTokens: 400 }
      );

      const result = parseJsonResponse<{
        status:            string;
        pillar:            string;
        extracted_facts:   string;
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
        status:            'APPROVED',
        pillar,
        extracted_facts:   result.extracted_facts   || '',
        translation_notes: result.translation_notes || '',
      };
    } catch (err) {
      return { status: 'PARSE_ERROR', reason: `Exception: ${(err as Error).message}` };
    }
  }

  // ── Main entry point ──────────────────────────────────────────────────────

  /**
   * Run one underquota round for the given missing pillar labels.
   *
   * Implements Scout-parity bucket-aware triage:
   *   1. Local mutable buckets track per-pillar fill state.
   *   2. Predictive skip drops items from sources with ≥70% historical
   *      affinity for an already-full pillar BEFORE the LLM call.
   *   3. Adaptive batch size scales with remaining slot count.
   *   4. Early termination when all target pillars are filled.
   *   5. Hard pillar cap prevents over-fill on the LLM's results.
   */
  async run(
    missingPillarLabels: string[],
    rejectedUrls: Set<string> = new Set()
  ): Promise<ScoutItem[]> {
    const targetPillars = missingPillarLabels
      .map((label) => PILLAR_FROM_LABEL[label])
      .filter((p): p is Pillar => Boolean(p));

    if (targetPillars.length === 0) {
      this.log('[Underquota] No valid target pillars resolved — skipping dispatch.');
      return [];
    }

    const feedUrls = this.getFeedsForPillars(targetPillars);

    if (feedUrls.length === 0) {
      this.log(
        `[Underquota] No PRIORITY_FEEDS tagged for: ${targetPillars.join(', ')} — skipping dispatch.`
      );
      return [];
    }

    const feedDomains = feedUrls
      .map((u) => { try { return new URL(u).hostname; } catch { return u; } })
      .join(', ');

    this.log(
      `[Underquota] Targeting pillars: ${targetPillars.join(', ')} | ` +
      `${feedUrls.length} tagged priority feed(s): ${feedDomains}`
    );

    const memory = await this.getMemory();
    const pool   = await this.buildPool(feedUrls, rejectedUrls, memory, targetPillars);

    if (pool.length === 0) {
      this.log('[Underquota] Pool empty — no new items from tagged priority feeds.');
      return [];
    }

    this.log(`[Underquota] Pool: ${pool.length} item(s). Starting bucket-aware triage…`);

    // ── Local fill tracking (parity with Scout's triageAll) ───────────────
    const localBuckets: Record<Pillar, number> = {
      anime: 0, gaming: 0, infotainment: 0, manga: 0, toys: 0,
    };
    const isPillarFull   = (p: Pillar) => localBuckets[p] >= MAX_CANDIDATES_PER_PILLAR;
    const allTargetsFull = ()           => targetPillars.every(isPillarFull);

    const approved:  ScoutItem[]  = [];
    let   remaining               = [...pool];
    let   batchNum                = 0;
    let   predictiveSkipTotal     = 0;

    while (remaining.length > 0 && !allTargetsFull()) {
      // ── Adaptive batch size ────────────────────────────────────────────
      // Sum remaining slots across target pillars × overshoot factor; clamp
      // to [MIN_BATCH_SIZE, MAX_BATCH_SIZE].  Wide batches early when slots
      // are wide-open, narrow batches near the finish line so we don't
      // overshoot.
      const remainingSlots = targetPillars.reduce(
        (sum, p) => sum + Math.max(0, MAX_CANDIDATES_PER_PILLAR - localBuckets[p]),
        0
      );
      const desiredBatch = Math.max(
        MIN_BATCH_SIZE,
        Math.min(MAX_BATCH_SIZE, remainingSlots * ADAPTIVE_OVERSHOOT)
      );

      // ── Predictive skip ────────────────────────────────────────────────
      // Drop items whose source overwhelmingly produces content for an
      // already-full pillar BEFORE the LLM call.
      const batch:       PoolItem[] = [];
      const skippedHere: PoolItem[] = [];

      for (const item of remaining) {
        if (batch.length >= desiredBatch) break;

        let predictiveSkip = false;
        for (const p of PILLARS) {
          if (!isPillarFull(p)) continue;
          if (pillarShareOf(item.sourceFeed, p, memory) >= PREDICTIVE_SKIP_THRESHOLD) {
            predictiveSkip = true;
            break;
          }
        }

        if (predictiveSkip) skippedHere.push(item);
        else                batch.push(item);
      }

      // Remove handled items from `remaining`
      const handledLinks = new Set([
        ...batch.map((i) => i.link),
        ...skippedHere.map((i) => i.link),
      ]);
      remaining = remaining.filter((i) => !handledLinks.has(i.link));

      // Predictive skips count as triaged so retries never re-fetch them
      for (const item of skippedHere) this.triagedUrls.add(item.link);
      predictiveSkipTotal += skippedHere.length;

      if (batch.length === 0 && skippedHere.length > 0) {
        this.log(
          `[Underquota] predictive skip dropped ${skippedHere.length} item(s) ` +
          `(source ≥${(PREDICTIVE_SKIP_THRESHOLD * 100).toFixed(0)}% affinity for full pillar)`
        );
        continue;
      }
      if (batch.length === 0) break;

      batchNum++;

      const fillState = targetPillars
        .map((p) => `${p}:${localBuckets[p]}/${MAX_CANDIDATES_PER_PILLAR}`)
        .join(' ');
      const skipNote = skippedHere.length > 0
        ? ` | predictive-skip:${skippedHere.length}`
        : '';

      this.log(
        `[Underquota] Batch ${batchNum} (${batch.length} items, adaptive=${desiredBatch}${skipNote}, ${remaining.length} remaining) | ${fillState}`
      );

      // Mark as triaged BEFORE LLM call
      for (const item of batch) this.triagedUrls.add(item.link);

      const triageResults = await Promise.all(
        batch.map((item) => this.triageItem(item.title, item.summary, targetPillars))
      );

      let accepted = 0, rejected = 0, errors = 0, capped = 0;

      for (let i = 0; i < triageResults.length; i++) {
        const result = triageResults[i];
        const item   = batch[i];

        if (result.status === 'REJECTED') {
          rejected++;
          this.log(`[Underquota] ✗ REJECTED  — ${result.reason} | "${item.title}"`);
          continue;
        }
        if (result.status === 'PARSE_ERROR') {
          errors++;
          this.log(`[Underquota] ✗ ERROR     — ${result.reason} | "${item.title}"`);
          continue;
        }

        // Hard pillar cap — drop if pillar already full locally
        if (isPillarFull(result.pillar)) {
          capped++;
          this.log(
            `[Underquota] ~ FULL     [${result.pillar}] (${localBuckets[result.pillar]}/${MAX_CANDIDATES_PER_PILLAR}) | "${item.title}"`
          );
          continue;
        }

        accepted++;
        localBuckets[result.pillar]++;
        approved.push({
          title:            item.title,
          link:             item.link,
          summary:          item.summary,
          pillar:           result.pillar,
          translationNotes: result.translation_notes,
        });
        this.log(
          `[Underquota] ✓ ACCEPTED  [${result.pillar}] (${localBuckets[result.pillar]}/${MAX_CANDIDATES_PER_PILLAR}) ` +
          `[${item.sourceFeed}] | "${item.title}"`
        );
      }

      this.log(
        `[Underquota] Batch ${batchNum} done — ✓${accepted} ✗${rejected} cap:${capped} err:${errors} | ` +
        targetPillars.map((p) => `${p}:${localBuckets[p]}`).join(' ')
      );
    }

    if (allTargetsFull()) {
      this.log(
        `[Underquota] All ${targetPillars.length} target pillar(s) satisfied. ` +
        `Stopping early — ${remaining.length} item(s) untouched, ${predictiveSkipTotal} predictively skipped. ` +
        `LLM cost saved: ~${remaining.length + predictiveSkipTotal} call(s).`
      );
    } else if (predictiveSkipTotal > 0) {
      this.log(
        `[Underquota] Total predictive skips: ${predictiveSkipTotal} (LLM calls saved)`
      );
    }

    this.log(
      `[Underquota] Handover complete — ${approved.length} topic(s) returned to Master.`
    );
    return approved;
  }
}
