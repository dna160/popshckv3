/**
 * Agent 1: RSS Feeder & Triage (The Scout)
 *
 * Algorithm: Freshness & Parallel Scatter  +  Adaptive Feed Prioritization
 *
 *   Phase 1 — Concurrent Aggregation
 *             All PRIORITY_FEEDS fetched simultaneously via Promise.allSettled.
 *
 *   Phase 2 — Global Freshness Sort + Age Filter
 *             Pool sorted by pubDate descending; items older than AGE_LIMIT_DAYS dropped.
 *
 *   Phase 3 — Anti-Dominance Shuffle
 *             Top FRESH_POOL_SIZE items Fisher-Yates shuffled to prevent any single
 *             high-volume feed monopolising the triage queue.
 *
 *   Phase 4 — Adaptive Batch Triage
 *             Items triaged in parallel batches of BATCH_SIZE.
 *             After each batch, remaining items are re-sorted by a "need score":
 *             items from feeds affiliated with underfilled buckets float to the top;
 *             items from feeds whose bucket is already full sink to the bottom
 *             (but are never discarded — they stay as low-priority fallback).
 *
 *   Phase 5 — Underquota Retry
 *             If any pillar bucket is still under TARGET_PER_PILLAR after Phase 4,
 *             the Scout re-fetches feeds with an expanded age window (AGE_RETRY_DAYS)
 *             and repeats the triage loop for the missing pillars only.
 *             Up to MAX_RETRY_ROUNDS retries are attempted.
 */

import { PrismaClient } from '@prisma/client';
import { fetchPillarFeeds } from '../services/rss';
import { chat, parseJsonResponse } from '../services/llm';
import type { Pillar, ScoutItem } from '../../../shared/types';
import { PILLARS, PILLAR_LABELS } from '../../../shared/types';

// ── Constants ────────────────────────────────────────────────────────────────
const TARGET_PER_PILLAR         = 10;   // Hard minimum per pillar
const MAX_CANDIDATES_PER_PILLAR = 10;   // Bucket cap (same as target)
const FRESH_POOL_SIZE           = 150;  // Top-N freshest items to shuffle
const BATCH_SIZE                = 10;   // Parallel LLM calls per triage batch
const AGE_LIMIT_DAYS            = 7;    // Initial age filter
const AGE_RETRY_DAYS            = 14;   // Expanded age filter on retry
const MAX_RETRY_ROUNDS          = 2;    // Max underquota retry attempts

// ── Feed → Pillar affinity ────────────────────────────────────────────────────
// Maps feed domain substrings to the pillar they predominantly produce.
// Used to dynamically re-score the remaining pool after each batch so that
// items from feeds aligned with underfilled buckets are prioritised.
const FEED_AFFINITY: Array<{ pattern: string; pillar: Pillar }> = [
  // Gaming feeds
  { pattern: '4gamer.net',          pillar: 'gaming' },
  { pattern: 'automaton-media.com', pillar: 'gaming' },
  { pattern: 'denfaminicogamer.jp', pillar: 'gaming' },
  { pattern: 'siliconera.com',      pillar: 'gaming' },
  // Toys / Collectibles feeds
  { pattern: 'dengeki.com',         pillar: 'toys'   },
  { pattern: 'toy-people.com',      pillar: 'toys'   },
  { pattern: 'ngeekhiong.blogspot', pillar: 'toys'   },
  { pattern: 'gunjap.net',          pillar: 'toys'   },
  { pattern: 'toyark.com',          pillar: 'toys'   },
  // Infotainment feeds
  { pattern: 'essential-japan.com', pillar: 'infotainment' },
  { pattern: 'soranews24.com',      pillar: 'infotainment' },
  { pattern: 'japantoday.com',      pillar: 'infotainment' },
  { pattern: 'tokyoweekender.com',  pillar: 'infotainment' },
  // Manga feeds
  { pattern: 'animenewsnetwork.com',pillar: 'manga'  },
  { pattern: 'animecorner.me',      pillar: 'manga'  },
  // Anime / Mixed feeds (lower affinity score — they'll compete with above)
  { pattern: 'natalie.mu',          pillar: 'anime'  },
  { pattern: 'hostdon.jp',          pillar: 'anime'  },
];

// ── Pillar label → Pillar alias map ──────────────────────────────────────────
const PILLAR_FROM_LABEL: Record<string, Pillar> = {
  // Canonical labels
  'Japanese Anime':             'anime',
  'Japanese Gaming':            'gaming',
  'Japanese Infotainment':      'infotainment',
  'Japanese Manga':             'manga',
  'Japanese Toys/Collectibles': 'toys',
  // Common LLM short-form aliases
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
  title:   string;
  link:    string;
  summary: string;
  pubDate?: string;
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Return the affinity pillar for an item's URL, or null if unknown. */
function getAffinity(url: string): Pillar | null {
  for (const entry of FEED_AFFINITY) {
    if (url.includes(entry.pattern)) return entry.pillar;
  }
  return null;
}

/**
 * Compute a 0–1 priority score for an item given current bucket fill levels.
 * Higher score = higher priority = processed sooner.
 *   - Affinity pillar bucket empty  → score ~1.0
 *   - Affinity pillar bucket full   → score ~0.1  (deprioritised, not dropped)
 *   - No known affinity             → score  0.5  (neutral)
 */
function needScore(item: PoolItem, buckets: Record<Pillar, ScoutItem[]>): number {
  const affinity = getAffinity(item.link);
  if (!affinity) return 0.5;
  const fill = buckets[affinity].length / MAX_CANDIDATES_PER_PILLAR;
  if (fill >= 1.0) return 0.1;
  return 1.0 - fill * 0.9; // 1.0 when empty, 0.1 when full
}

// ── Scout class ───────────────────────────────────────────────────────────────
export class Scout {
  private prisma: PrismaClient;
  private log: (msg: string) => void;

  constructor(prisma: PrismaClient, log: (msg: string) => void = console.log) {
    this.prisma = prisma;
    this.log = log;
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

  // ── Triage a single item via LLM ─────────────────────────────────────────────

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
        return {
          status: 'PARSE_ERROR',
          reason: `Unknown pillar label from LLM: "${result.pillar}"`,
        };
      }

      return {
        status: 'APPROVED',
        pillar,
        extracted_facts:   result.extracted_facts   || '',
        translation_notes: result.translation_notes || '',
      };
    } catch (err) {
      return {
        status: 'PARSE_ERROR',
        reason: `LLM/parse exception: ${(err as Error).message}`,
      };
    }
  }

  // ── Core triage loop (reused across initial run + retries) ───────────────────

  private async triagePool(
    pool: PoolItem[],
    buckets: Record<Pillar, ScoutItem[]>,
    roundLabel: string
  ): Promise<void> {
    const allFull = () => PILLARS.every((p) => buckets[p].length >= MAX_CANDIDATES_PER_PILLAR);

    // Mutable remaining list — re-sorted after every batch
    const remaining = [...pool];
    let batchNum = 0;

    while (remaining.length > 0 && !allFull()) {
      // Re-sort by need score so underrepresented pillars bubble to the top
      remaining.sort((a, b) => needScore(b, buckets) - needScore(a, buckets));

      const batch = remaining.splice(0, BATCH_SIZE);
      batchNum++;

      this.log(`[Scout] ${roundLabel} — Triaging batch ${batchNum} (${batch.length} items, ${remaining.length} remaining)...`);

      const results = await Promise.all(
        batch.map((item) => this.triageItem(item.title, item.summary))
      );

      let batchAccepted = 0, batchRejected = 0, batchErrors = 0, batchDropped = 0;

      for (let j = 0; j < results.length; j++) {
        const result = results[j];
        const item   = batch[j];

        if (result.status === 'REJECTED') {
          batchRejected++;
          this.log(`[Scout] ✗ REJECTED  — ${result.reason} | "${item.title}"`);
          continue;
        }

        if (result.status === 'PARSE_ERROR') {
          batchErrors++;
          this.log(`[Scout] ✗ ERROR     — ${result.reason} | "${item.title}"`);
          continue;
        }

        // APPROVED
        const bucket = buckets[result.pillar];
        if (bucket.length < MAX_CANDIDATES_PER_PILLAR) {
          bucket.push({
            title:            item.title,
            link:             item.link,
            summary:          item.summary,
            pillar:           result.pillar,
            translationNotes: result.translation_notes,
          });
          batchAccepted++;
          this.log(`[Scout] ✓ ACCEPTED  [${result.pillar}] (${bucket.length}/${MAX_CANDIDATES_PER_PILLAR}) | "${item.title}"`);
        } else {
          batchDropped++;
          this.log(`[Scout] ~ BUCKET FULL [${result.pillar}] — low-priority fallback discarded | "${item.title}"`);
        }
      }

      const bucketSummary = PILLARS.map(
        (p) => `${p}:${buckets[p].length}/${MAX_CANDIDATES_PER_PILLAR}`
      ).join('  ');
      this.log(
        `[Scout] Batch ${batchNum} done — ` +
        `✓${batchAccepted} ✗${batchRejected} err:${batchErrors} drop:${batchDropped} | ${bucketSummary}`
      );
    }
  }

  // ── Build a deduplicated pool from feeds with given age limit ─────────────────

  private async buildPool(
    ageDays: number,
    rejectedUrls: Set<string>,
    seenInRun: Set<string>
  ): Promise<PoolItem[]> {
    const rawItems = await fetchPillarFeeds('anime'); // fetches all PRIORITY_FEEDS

    // Sort freshest first
    const sorted = [...rawItems].sort((a, b) => {
      const ta = a.pubDate ? new Date(a.pubDate).getTime() : 0;
      const tb = b.pubDate ? new Date(b.pubDate).getTime() : 0;
      return tb - ta;
    });

    // Age filter
    const cutoff = Date.now() - ageDays * 24 * 60 * 60 * 1000;
    const aged = sorted.filter((item) => {
      if (!item.pubDate) return true;
      return new Date(item.pubDate).getTime() >= cutoff;
    });
    const dropped = sorted.length - aged.length;
    if (dropped > 0) {
      this.log(`[Scout] Age filter (${ageDays}d): dropped ${dropped} stale items (${aged.length} remain)`);
    }

    // Dedup: skip already-processed URLs and anything seen in this run
    const unprocessed: PoolItem[] = [];
    for (const item of aged) {
      if (rejectedUrls.has(item.link)) continue;
      if (seenInRun.has(item.link)) continue;
      const seen = await this.isProcessed(item.link);
      if (seen) {
        this.log(`[Scout] Skipping already-processed: ${item.link}`);
        seenInRun.add(item.link);
        continue;
      }
      seenInRun.add(item.link);
      unprocessed.push(item);
    }

    // Anti-dominance shuffle on top N
    const topFresh = unprocessed.slice(0, FRESH_POOL_SIZE);
    const rest     = unprocessed.slice(FRESH_POOL_SIZE);
    return [...shuffle(topFresh), ...rest];
  }

  // ── Main run ─────────────────────────────────────────────────────────────────

  async run(rejectedUrls: Set<string> = new Set()): Promise<ScoutItem[]> {
    this.log('[Scout] Starting Freshness & Parallel Scatter run...');

    const buckets: Record<Pillar, ScoutItem[]> = {
      anime: [], gaming: [], infotainment: [], manga: [], toys: [],
    };

    // Tracks every URL we've evaluated this run so retries don't re-evaluate them
    const seenInRun = new Set<string>();

    // ── Initial pass (7-day window) ───────────────────────────────────────────
    this.log(`[Scout] Phase 1-3: Building fresh pool (${AGE_LIMIT_DAYS}-day window)...`);
    const initialPool = await this.buildPool(AGE_LIMIT_DAYS, rejectedUrls, seenInRun);

    if (initialPool.length === 0) {
      this.log('[Scout] No new items found in feeds.');
      return [];
    }
    this.log(`[Scout] Pool ready: ${initialPool.length} items. Starting triage...`);
    await this.triagePool(initialPool, buckets, 'Round 1');

    // ── Underquota retry loop ─────────────────────────────────────────────────
    for (let retry = 1; retry <= MAX_RETRY_ROUNDS; retry++) {
      const underquota = PILLARS.filter((p) => buckets[p].length < TARGET_PER_PILLAR);
      if (underquota.length === 0) break;

      this.log(
        `[Scout] ⚠ Underquota after round ${retry}: ${underquota.map((p) => `${PILLAR_LABELS[p]}(${buckets[p].length}/${TARGET_PER_PILLAR})`).join(', ')} — retrying with ${AGE_RETRY_DAYS}-day window...`
      );

      const retryPool = await this.buildPool(AGE_RETRY_DAYS, rejectedUrls, seenInRun);
      if (retryPool.length === 0) {
        this.log(`[Scout] Retry ${retry}: No additional items found. Stopping.`);
        break;
      }
      this.log(`[Scout] Retry ${retry}: ${retryPool.length} additional items available.`);
      await this.triagePool(retryPool, buckets, `Retry ${retry}`);
    }

    // ── Final summary ─────────────────────────────────────────────────────────
    const selected: ScoutItem[] = [];
    for (const pillar of PILLARS) {
      for (const item of buckets[pillar]) {
        selected.push(item);
      }
      if (buckets[pillar].length < TARGET_PER_PILLAR) {
        this.log(
          `[Scout] ⚠ Final underquota: ${buckets[pillar].length}/${TARGET_PER_PILLAR} for ${PILLAR_LABELS[pillar]} — pool exhausted`
        );
      }
    }

    this.log(`[Scout] Triage complete. ${selected.length} candidates across ${PILLARS.length} pillars.`);
    return selected;
  }
}
