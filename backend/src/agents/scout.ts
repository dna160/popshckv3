/**
 * Agent 1: RSS Feeder & Triage (The Scout)
 *
 * Algorithm: Freshness & Parallel Scatter  +  Empirical Feed Memory
 *
 *   Phase 1 — Concurrent Aggregation
 *             All PRIORITY_FEEDS fetched simultaneously. Each item is tagged
 *             with the hostname of the feed it came from (sourceFeed).
 *
 *   Phase 2 — Global Freshness Sort + Age Filter
 *             Pool sorted by pubDate descending; items older than AGE_LIMIT_DAYS
 *             are discarded.
 *
 *   Phase 3 — Anti-Dominance Shuffle
 *             Top FRESH_POOL_SIZE items Fisher-Yates shuffled to prevent a single
 *             high-volume feed from monopolising early batches.
 *
 *   Phase 4 — Adaptive Batch Triage with Empirical Memory
 *             Items triaged in parallel batches of BATCH_SIZE.
 *             After each batch, the remaining pool is re-scored using FeedMemory:
 *
 *             score(item) = Σ_pillar [ historical_rate(feed, pillar) × need(pillar) ]
 *
 *             where:
 *               historical_rate(feed, pillar) = past approvals for this pillar from feed
 *                                               ─────────────────────────────────────
 *                                               total approvals from feed (all pillars)
 *               need(pillar) = 1 − (bucket_fill / MAX_CANDIDATES_PER_PILLAR)
 *
 *             Feeds with no history score 0.5 (neutral — not penalised).
 *             Every APPROVED outcome updates the persistent memory file so the
 *             system becomes more accurate with each run.
 *
 *   Phase 5 — Underquota Retry
 *             If any pillar is still under TARGET_PER_PILLAR, re-fetch with an
 *             expanded age window (AGE_RETRY_DAYS) and re-run triage, up to
 *             MAX_RETRY_ROUNDS times.
 */

import path from 'path';
import fs   from 'fs/promises';
import { PrismaClient } from '@prisma/client';
import { fetchFeed, RSS_FEEDS, PRIORITY_FEEDS } from '../services/rss';
import { chat, parseJsonResponse } from '../services/llm';
import type { Pillar, ScoutItem } from '../../../shared/types';
import { PILLARS, PILLAR_LABELS } from '../../../shared/types';

// ── Constants ────────────────────────────────────────────────────────────────
const TARGET_PER_PILLAR         = 10;
const MAX_CANDIDATES_PER_PILLAR = 10;
const FRESH_POOL_SIZE           = 150;
const RETRY_POOL_SIZE           = 50;   // additional items fetched per retry round (from fallback feeds)
const BATCH_SIZE                = 10;
const AGE_LIMIT_DAYS            = 7;
const AGE_RETRY_DAYS            = 14;
const MAX_RETRY_ROUNDS          = 3;

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

    // Shuffle the freshest slice; leave the remainder in date order
    const topFresh = unprocessed.slice(0, maxItems);
    const rest     = unprocessed.slice(maxItems);
    return [...shuffle(topFresh), ...rest];
  }

  /**
   * Build a deduplicated, bucket-aware list of fallback feed URLs.
   *
   * Feeds are sorted by their FeedMemory usefulness score given the current
   * bucket state — feeds historically strong in already-full pillars are
   * pushed to the back (or skipped if scoring zero).  Feeds with no history
   * score 0.5 (neutral) and are included near the front.
   *
   * This means if gaming is full, siliconera.com (100% gaming history) will
   * rank last among fallback sources, while animenewsnetwork.com (anime) and
   * soranews24.com (infotainment) will be fetched first.
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

    for (const pillar of PILLARS) {
      for (const url of RSS_FEEDS[pillar as Pillar]) {
        if (!seen.has(url)) {
          seen.add(url);
          let domain = url;
          try { domain = new URL(url).hostname; } catch { /* keep raw */ }
          entries.push({ url, score: memory.score(domain, buckets) });
        }
      }
    }

    // Sort descending by usefulness — feeds useful for open pillars come first
    entries.sort((a, b) => b.score - a.score);

    this.log(
      `[Scout] Fallback feed ranking: ` +
      entries.map((e) => {
        let domain = e.url;
        try { domain = new URL(e.url).hostname; } catch { /* keep raw */ }
        return `${domain}(${e.score.toFixed(2)})`;
      }).join(', ')
    );

    return entries.map((e) => e.url);
  }

  // ── Main run ─────────────────────────────────────────────────────────────────

  async run(rejectedUrls: Set<string> = new Set()): Promise<ScoutItem[]> {
    this.log('[Scout] Starting Freshness & Parallel Scatter run...');

    const memory = new FeedMemory();
    await memory.load(this.log);

    const memSummary = memory.summary();
    if (memSummary) {
      this.log(`[Scout] Historical feed memory: ${memSummary}`);
    }

    const buckets: Record<Pillar, ScoutItem[]> = {
      anime: [], gaming: [], infotainment: [], manga: [], toys: [],
    };
    // Only URLs actually sent to the LLM are tracked here.
    // Items fetched but never triaged (e.g. because a bucket filled mid-batch)
    // are NOT marked, so they remain available for the next round.
    const triagedUrls = new Set<string>();

    // ── Initial pass (Round 1): PRIORITY_FEEDS only ───────────────────────────
    this.log(
      `[Scout] Building initial pool from ${PRIORITY_FEEDS.length} priority feeds ` +
      `(${AGE_LIMIT_DAYS}-day window, cap: ${FRESH_POOL_SIZE})...`
    );
    const initialPool = await this.buildPool(
      PRIORITY_FEEDS, AGE_LIMIT_DAYS, rejectedUrls, triagedUrls, FRESH_POOL_SIZE
    );

    if (initialPool.length === 0) {
      this.log('[Scout] No new items found in priority feeds.');
      await memory.save(this.log);
      return [];
    }

    this.log(`[Scout] Pool: ${initialPool.length} items. Starting triage...`);
    await this.triagePool(initialPool, buckets, memory, triagedUrls, 'Round 1');

    // ── Retry loop (Round 2+): FALLBACK feeds, 50 new items per round ─────────
    //
    // Once PRIORITY_FEEDS are exhausted (all triaged items tracked in
    // triagedUrls), retry rounds fetch from RSS_FEEDS — the pillar-specific
    // fallback feeds that were NOT touched in Round 1.
    //
    // Each retry round pulls RETRY_POOL_SIZE (50) fresh items from those
    // feeds, ensuring the Scout always advances into genuinely new content
    // rather than re-scanning an already-exhausted pool.
    //
    // Stops when:
    //   (a) all pillar buckets reach TARGET_PER_PILLAR, OR
    //   (b) MAX_EMPTY_ROUNDS consecutive fallback fetches yield zero new items
    const MAX_EMPTY_ROUNDS = 3;
    let emptyRounds        = 0;
    let retryRound         = 1;

    while (true) {
      const under = PILLARS.filter((p) => buckets[p].length < TARGET_PER_PILLAR);
      if (under.length === 0) break; // ✓ all quotas met

      const missing = under
        .map((p) => `${PILLAR_LABELS[p]}(${TARGET_PER_PILLAR - buckets[p].length} needed)`)
        .join(', ');

      // Expand age window after the first retry to widen the candidate pool
      const ageDays = retryRound === 1 ? AGE_LIMIT_DAYS : AGE_RETRY_DAYS;

      // Re-rank fallback feeds each round based on current bucket state
      const fallbackUrls = this.fallbackFeedUrls(buckets, memory);

      this.log(
        `[Scout] ⚠ Underquota: ${missing} — fetching ${RETRY_POOL_SIZE} new items from ` +
        `${fallbackUrls.length} fallback feeds (round ${retryRound + 1}, ${ageDays}-day window)...`
      );

      const retryPool = await this.buildPool(
        fallbackUrls, ageDays, rejectedUrls, triagedUrls, RETRY_POOL_SIZE
      );

      if (retryPool.length === 0) {
        emptyRounds++;
        this.log(
          `[Scout] Round ${retryRound + 1}: no new items in fallback feeds ` +
          `(${emptyRounds}/${MAX_EMPTY_ROUNDS} empty rounds).`
        );
        if (emptyRounds >= MAX_EMPTY_ROUNDS) {
          this.log('[Scout] All feeds exhausted — proceeding with partial quota.');
          break;
        }
      } else {
        emptyRounds = 0;
        this.log(
          `[Scout] Round ${retryRound + 1}: ${retryPool.length} new items from fallback feeds. Triaging...`
        );
        await this.triagePool(retryPool, buckets, memory, triagedUrls, `Round ${retryRound + 1}`);
      }

      retryRound++;
      if (retryRound > MAX_RETRY_ROUNDS) {
        this.log(`[Scout] Max retry rounds (${MAX_RETRY_ROUNDS}) reached — proceeding with partial quota.`);
        break;
      }
    }

    // ── Save updated memory ───────────────────────────────────────────────────
    await memory.save(this.log);

    // ── Final summary ─────────────────────────────────────────────────────────
    const selected: ScoutItem[] = [];
    for (const pillar of PILLARS) {
      selected.push(...buckets[pillar]);
      if (buckets[pillar].length < TARGET_PER_PILLAR) {
        this.log(
          `[Scout] ⚠ Final underquota: ${buckets[pillar].length}/${TARGET_PER_PILLAR} for ${PILLAR_LABELS[pillar]}`
        );
      }
    }

    this.log(`[Scout] Complete — ${selected.length} candidates across ${PILLARS.length} pillars.`);
    this.log(`[Scout] Updated feed memory: ${memory.summary()}`);
    return selected;
  }
}
