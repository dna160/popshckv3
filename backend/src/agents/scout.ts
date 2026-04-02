/**
 * Agent 1: RSS Feeder & Triage (The Scout)
 *
 * Implements the "Freshness & Parallel Scatter" algorithm:
 *
 *   Phase 1 — Concurrent Aggregation
 *             All PRIORITY_FEEDS are fetched simultaneously via Promise.allSettled.
 *             Every item is merged into a single global pool tagged with its source feed.
 *
 *   Phase 2 — Global Chronological Sort
 *             Pool is sorted strictly by pubDate (newest first) so the absolute
 *             freshest articles across ALL feeds surface first.
 *
 *   Phase 3 — Anti-Dominance Shuffle
 *             The top FRESH_POOL_SIZE items are Fisher-Yates shuffled so that a
 *             single high-volume feed cannot monopolise the triage queue.
 *
 *   Phase 4 — Parallel Batch Triage (Bucket Filling)
 *             Items are evaluated in batches of BATCH_SIZE via Promise.all.
 *             Results fill per-pillar buckets up to MAX_CANDIDATES_PER_PILLAR.
 *             Processing stops as soon as every bucket is full or the pool
 *             is exhausted.
 */

import { PrismaClient } from '@prisma/client';
import { fetchPillarFeeds } from '../services/rss';
import { chat, parseJsonResponse } from '../services/llm';
import type { Pillar, ScoutItem } from '../../../shared/types';
import { PILLARS, PILLAR_LABELS } from '../../../shared/types';

const TARGET_PER_PILLAR      = 2;   // Pipeline success quota per pillar
const MAX_CANDIDATES_PER_PILLAR = 8; // Scout collects extras as replacement pool
const FRESH_POOL_SIZE        = 50;  // Top-N freshest items to shuffle
const BATCH_SIZE             = 10;  // Parallel LLM calls per triage batch

const PILLAR_FROM_LABEL: Record<string, Pillar> = {
  'Japanese Anime':            'anime',
  'Japanese Gaming':           'gaming',
  'Japanese Infotainment':     'infotainment',
  'Japanese Manga':            'manga',
  'Japanese Toys/Collectibles':'toys',
};

interface TriageResult {
  status: 'APPROVED' | 'REJECTED';
  pillar: Pillar;
  extracted_facts: string;
  translation_notes: string;
}

interface PoolItem {
  title:   string;
  link:    string;
  summary: string;
  pubDate?: string;
}

// ─── Fisher-Yates shuffle (in-place) ────────────────────────────────────────
function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export class Scout {
  private prisma: PrismaClient;
  private log: (msg: string) => void;

  constructor(prisma: PrismaClient, log: (msg: string) => void = console.log) {
    this.prisma = prisma;
    this.log = log;
  }

  // ── DB helpers ─────────────────────────────────────────────────────────────

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

  // ── Phase 4 helper: triage a single item ───────────────────────────────────

  private async triageItem(title: string, summary: string): Promise<TriageResult | null> {
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

      if (result.status === 'REJECTED') return null;

      const pillar = PILLAR_FROM_LABEL[result.pillar];
      if (!pillar) return null;

      return {
        status: 'APPROVED',
        pillar,
        extracted_facts:    result.extracted_facts    || '',
        translation_notes:  result.translation_notes  || '',
      };
    } catch (err) {
      this.log(`[Scout] Triage failed for "${title}": ${(err as Error).message}`);
      return null;
    }
  }

  // ── Main run ───────────────────────────────────────────────────────────────

  async run(rejectedUrls: Set<string> = new Set()): Promise<ScoutItem[]> {
    this.log('[Scout] Starting Freshness & Parallel Scatter run...');

    // ── Phase 1: Concurrent aggregation ─────────────────────────────────────
    this.log('[Scout] Phase 1: Fetching all feeds concurrently...');
    const rawItems = await fetchPillarFeeds('anime'); // fetches all PRIORITY_FEEDS at once

    // ── Phase 2: Global chronological sort (freshest first) ─────────────────
    this.log(`[Scout] Phase 2: Sorting ${rawItems.length} items by freshness...`);
    const sorted = [...rawItems].sort((a, b) => {
      const ta = a.pubDate ? new Date(a.pubDate).getTime() : 0;
      const tb = b.pubDate ? new Date(b.pubDate).getTime() : 0;
      return tb - ta; // descending — newest first
    });

    // Remove rejected and already-processed URLs
    const unprocessed: PoolItem[] = [];
    for (const item of sorted) {
      if (rejectedUrls.has(item.link)) continue;
      const seen = await this.isProcessed(item.link);
      if (seen) {
        this.log(`[Scout] Skipping already-processed: ${item.link}`);
        continue;
      }
      unprocessed.push(item);
    }

    if (unprocessed.length === 0) {
      this.log('[Scout] No new items found in feeds.');
      return [];
    }

    // ── Phase 3: Anti-dominance shuffle on top N freshest ───────────────────
    this.log(`[Scout] Phase 3: Shuffling top ${FRESH_POOL_SIZE} freshest items...`);
    const topFresh = unprocessed.slice(0, FRESH_POOL_SIZE);
    const rest     = unprocessed.slice(FRESH_POOL_SIZE);
    const pool     = [...shuffle(topFresh), ...rest]; // rest stays chronological as fallback

    // ── Phase 4: Parallel batch triage — fill per-pillar buckets ────────────
    this.log('[Scout] Phase 4: Parallel LLM triage in batches...');

    const buckets: Record<Pillar, ScoutItem[]> = {
      anime: [], gaming: [], infotainment: [], manga: [], toys: [],
    };

    const allFull = () =>
      PILLARS.every((p) => buckets[p].length >= MAX_CANDIDATES_PER_PILLAR);

    for (let i = 0; i < pool.length && !allFull(); i += BATCH_SIZE) {
      const batch = pool.slice(i, i + BATCH_SIZE);

      this.log(`[Scout] Triaging batch ${Math.floor(i / BATCH_SIZE) + 1} (${batch.length} items)...`);

      // Evaluate entire batch in parallel
      const results = await Promise.all(
        batch.map((item) => this.triageItem(item.title, item.summary))
      );

      for (let j = 0; j < results.length; j++) {
        const result = results[j];
        const item   = batch[j];

        if (!result) {
          this.log(`[Scout] Rejected: "${item.title}"`);
          continue;
        }

        const bucket = buckets[result.pillar];
        if (bucket.length < MAX_CANDIDATES_PER_PILLAR) {
          bucket.push({
            title:            item.title,
            link:             item.link,
            summary:          item.summary,
            pillar:           result.pillar,
            translationNotes: result.translation_notes,
          });
          this.log(`[Scout] Accepted [${result.pillar}] (${bucket.length}/${MAX_CANDIDATES_PER_PILLAR}): "${item.title}"`);
        }
      }
    }

    // Flatten buckets and log summary
    const selected: ScoutItem[] = [];
    for (const pillar of PILLARS) {
      for (const item of buckets[pillar]) {
        selected.push(item);
      }
      if (buckets[pillar].length < TARGET_PER_PILLAR) {
        this.log(
          `[Scout] Warning: Only ${buckets[pillar].length}/${TARGET_PER_PILLAR} candidates for ${PILLAR_LABELS[pillar]}`
        );
      }
    }

    this.log(`[Scout] Triage complete. ${selected.length} candidates across ${PILLARS.length} pillars.`);
    return selected;
  }
}
