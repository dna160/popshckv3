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
 *   • Return ALL approved ScoutItems to the Master; quota-capping is the
 *     Master's responsibility.
 *
 * Pool cap : UNDERQUOTA_POOL_SIZE = 50
 * Age window: AGE_LIMIT_DAYS = 7
 * Batch size: BATCH_SIZE = 10
 */

import { PrismaClient }            from '@prisma/client';
import { fetchFeed, PRIORITY_FEEDS, FEED_FALLBACK_MAP } from '../services/rss';
import { chat, parseJsonResponse }  from '../services/llm';
import type { Pillar, ScoutItem }   from '../shared/types';

// ── Constants ─────────────────────────────────────────────────────────────────
const UNDERQUOTA_POOL_SIZE = 50;
const BATCH_SIZE           = 10;
const AGE_LIMIT_DAYS       = 7;

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
 * Fair-Source Interleave Algorithm
 *
 * Groups items by source, sorts each bucket newest-first, then draws
 * one item from each source in a round-robin fashion until all buckets
 * are exhausted. Guarantees the first N items in the result represent
 * N different publishers — no hard caps, no artificial limits.
 */
function fairSourceInterleave(items: PoolItem[]): PoolItem[] {
  const buckets = new Map<string, PoolItem[]>();
  for (const item of items) {
    if (!buckets.has(item.sourceFeed)) buckets.set(item.sourceFeed, []);
    buckets.get(item.sourceFeed)!.push(item);
  }

  for (const bucket of buckets.values()) {
    bucket.sort((a, b) => {
      const ta = a.pubDate ? new Date(a.pubDate).getTime() : 0;
      const tb = b.pubDate ? new Date(b.pubDate).getTime() : 0;
      return tb - ta;
    });
  }

  const result:   PoolItem[]   = [];
  const sources:  PoolItem[][] = [...buckets.values()];
  let drawIndex   = 0;
  let keepDrawing = true;

  while (keepDrawing) {
    keepDrawing = false;
    for (const bucket of sources) {
      if (drawIndex < bucket.length) {
        result.push(bucket[drawIndex]);
        keepDrawing = true;
      }
    }
    drawIndex++;
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
   * rounds within a single pipeline run.  Prevents re-triage of the same item
   * if the Orchestrator dispatches multiple consecutive underquota rounds.
   *
   * Reset automatically because the Orchestrator creates a fresh instance on
   * every pipeline run.
   */
  private triagedUrls: Set<string> = new Set();

  constructor(prisma: PrismaClient, log: (msg: string) => void = console.log) {
    this.prisma = prisma;
    this.log    = log;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async isProcessed(url: string): Promise<boolean> {
    return (await this.prisma.processedUrl.findUnique({ where: { url } })) !== null;
  }

  /**
   * Return the URLs of every PRIORITY_FEEDS entry whose tags include at least
   * one of the target pillars, deduplicated and in declaration order.
   */
  private getFeedsForPillars(targetPillars: Pillar[]): string[] {
    const seen = new Set<string>();
    const urls: string[] = [];

    for (const feed of PRIORITY_FEEDS) {
      if (feed.tags.some((tag) => targetPillars.includes(tag))) {
        if (!seen.has(feed.url)) {
          seen.add(feed.url);
          urls.push(feed.url);
        }
      }
    }

    return urls;
  }

  /**
   * Fetch `feedUrls`, deduplicate, age-filter, skip already-processed /
   * already-triaged URLs, and return up to UNDERQUOTA_POOL_SIZE candidates
   * ordered by the Fair-Source Interleave algorithm.
   */
  private async buildPool(
    feedUrls:     string[],
    rejectedUrls: Set<string>
  ): Promise<PoolItem[]> {
    // ── Step 1: Fetch all feeds concurrently (with per-feed fallback) ─────────
    const feedResults = await Promise.allSettled(
      feedUrls.map((url) => fetchFeed(url, 'anime', FEED_FALLBACK_MAP.get(url)))
    );

    // ── Step 2: Collect and deduplicate raw items ─────────────────────────────
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

    // ── Step 3: Fair-source interleave ────────────────────────────────────────
    const interleaved = fairSourceInterleave(rawItems);

    const sourceCount = new Set(rawItems.map((i) => i.sourceFeed)).size;
    this.log(
      `[Underquota] Fair-source interleave — ${interleaved.length} items across ${sourceCount} source(s)`
    );

    // ── Step 4: Age filter ────────────────────────────────────────────────────
    const cutoff = Date.now() - AGE_LIMIT_DAYS * 24 * 60 * 60 * 1000;
    const aged   = interleaved.filter((item) =>
      !item.pubDate || new Date(item.pubDate).getTime() >= cutoff
    );

    // ── Step 5: Remove already-processed / triaged / rejected URLs ────────────
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
   * The LLM is told which pillars are underquota so it can frame its
   * classification with those priorities in mind.  Off-pillar approvals
   * are still returned — the Master's processHandover() handles capping.
   */
  private async triageItem(
    title:         string,
    summary:       string,
    targetPillars: Pillar[]
  ): Promise<
    | { status: 'APPROVED'; pillar: Pillar; extracted_facts: string; translation_notes: string }
    | { status: 'REJECTED' | 'PARSE_ERROR'; reason: string }
  > {
    const targetLabels = targetPillars.map((p) => PILLAR_LABEL[p]).join(', ');

    const prompt = `You are the **Underquota Scout** for a Japanese pop-culture newsroom pipeline. \
The pipeline has not yet met its article quota for the pillars listed below. \
Your job is to classify this RSS item and extract key facts.

**UNDERQUOTA PILLARS (still need articles):** ${targetLabels}

**INSTRUCTIONS:**
1. Classify the item into EXACTLY ONE of the following 5 pillars:
   - Japanese Anime
   - Japanese Gaming
   - Japanese Infotainment
   - Japanese Manga
   - Japanese Toys/Collectibles
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
   * Called directly by the Master Orchestrator whenever a pillar is still
   * below quota after Round 1 (or a previous underquota round).
   *
   * @param missingPillarLabels  Human-readable labels e.g. ['Japanese Manga', 'Japanese Toys/Collectibles']
   * @param rejectedUrls         URLs the pipeline has already ruled out this run
   * @returns                    All approved ScoutItems; Master applies quota caps
   */
  async run(
    missingPillarLabels: string[],
    rejectedUrls: Set<string> = new Set()
  ): Promise<ScoutItem[]> {
    // Resolve labels to internal pillar keys
    const targetPillars = missingPillarLabels
      .map((label) => PILLAR_FROM_LABEL[label])
      .filter((p): p is Pillar => Boolean(p));

    if (targetPillars.length === 0) {
      this.log('[Underquota] No valid target pillars resolved — skipping dispatch.');
      return [];
    }

    // Select PRIORITY_FEEDS entries tagged for these pillars
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

    // Build pool (up to 50 items, deduplicated, age-filtered)
    const pool = await this.buildPool(feedUrls, rejectedUrls);

    if (pool.length === 0) {
      this.log('[Underquota] Pool empty — no new items from tagged priority feeds.');
      return [];
    }

    this.log(`[Underquota] Pool: ${pool.length} item(s). Starting triage...`);

    const approved: ScoutItem[] = [];
    const batches  = Math.ceil(pool.length / BATCH_SIZE);

    for (let b = 0; b < batches; b++) {
      const batch = pool.slice(b * BATCH_SIZE, (b + 1) * BATCH_SIZE);

      // Mark as triaged BEFORE LLM call — retries never re-evaluate same URL
      for (const item of batch) this.triagedUrls.add(item.link);

      const results = await Promise.all(
        batch.map((item) => this.triageItem(item.title, item.summary, targetPillars))
      );

      let accepted = 0, rejected = 0, errors = 0;

      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const item   = batch[i];

        if (result.status === 'APPROVED') {
          accepted++;
          approved.push({
            title:            item.title,
            link:             item.link,
            summary:          item.summary,
            pillar:           result.pillar,
            translationNotes: result.translation_notes,
          });
          this.log(
            `[Underquota] ✓ ACCEPTED  [${result.pillar}] [${item.sourceFeed}] | "${item.title}"`
          );
        } else if (result.status === 'REJECTED') {
          rejected++;
          this.log(`[Underquota] ✗ REJECTED  — ${result.reason} | "${item.title}"`);
        } else {
          errors++;
          this.log(`[Underquota] ✗ ERROR     — ${result.reason} | "${item.title}"`);
        }
      }

      this.log(
        `[Underquota] Batch ${b + 1}/${batches} — ✓${accepted} ✗${rejected} err:${errors}`
      );
    }

    this.log(
      `[Underquota] Handover complete — ${approved.length} topic(s) returned to Master.`
    );
    return approved;
  }
}
