/**
 * Agent 1: RSS Feeder & Triage (The Scout)
 *
 * Responsibilities:
 * - Poll all priority RSS feeds (mixed-topic sources)
 * - Dynamically categorize each item into one of the 5 pillars
 * - Extract localization/translation notes for proper nouns
 * - Deduplicate against ProcessedUrl DB table
 * - Select exactly 2 articles per pillar (10 total per run)
 */

import { PrismaClient } from '@prisma/client';
import { fetchPillarFeeds } from '../services/rss';
import { chat, parseJsonResponse } from '../services/llm';
import type { Pillar, ScoutItem } from '../../../shared/types';
import { PILLARS, PILLAR_LABELS } from '../../../shared/types';

const ARTICLES_PER_PILLAR = 2;

const PILLAR_FROM_LABEL: Record<string, Pillar> = {
  'Japanese Anime': 'anime',
  'Japanese Gaming': 'gaming',
  'Japanese Infotainment': 'infotainment',
  'Japanese Manga': 'manga',
  'Japanese Toys/Collectibles': 'toys',
};

interface TriageResult {
  status: 'APPROVED' | 'REJECTED';
  pillar: Pillar;
  extracted_facts: string;
  translation_notes: string;
}

export class Scout {
  private prisma: PrismaClient;
  private log: (msg: string) => void;

  constructor(prisma: PrismaClient, log: (msg: string) => void = console.log) {
    this.prisma = prisma;
    this.log = log;
  }

  /**
   * Check if a URL has already been processed.
   */
  private async isProcessed(url: string): Promise<boolean> {
    const existing = await this.prisma.processedUrl.findUnique({ where: { url } });
    return existing !== null;
  }

  /**
   * Mark a URL as processed to prevent re-processing.
   */
  async markProcessed(url: string): Promise<void> {
    await this.prisma.processedUrl.upsert({
      where: { url },
      update: {},
      create: { url },
    });
  }

  /**
   * Triage a single RSS item using the Scout Agent prompt.
   * Dynamically assigns pillar, extracts facts, and provides translation notes.
   * Returns null if the item is REJECTED or unparseable.
   */
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
        extracted_facts: result.extracted_facts || '',
        translation_notes: result.translation_notes || '',
      };
    } catch (err) {
      this.log(`[Scout] Triage failed for "${title}": ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Main Scout run: fetch all priority feeds, triage each item dynamically,
   * and return up to ARTICLES_PER_PILLAR items per pillar.
   *
   * Accepts a set of rejected URLs from the Researcher to exclude on retry.
   */
  async run(rejectedUrls: Set<string> = new Set()): Promise<ScoutItem[]> {
    this.log('[Scout] Starting RSS triage run...');

    // Fetch all priority feeds once (all pillars share the same mixed-topic feeds)
    const rawItems = await fetchPillarFeeds('anime');

    // Filter out rejected and already-processed URLs
    const candidates = rawItems.filter((item) => !rejectedUrls.has(item.link));

    const unprocessed: typeof candidates = [];
    for (const item of candidates) {
      const processed = await this.isProcessed(item.link);
      if (processed) {
        this.log(`[Scout] Skipping already-processed: ${item.link}`);
      } else {
        unprocessed.push(item);
      }
    }

    if (unprocessed.length === 0) {
      this.log('[Scout] No new items found in feeds.');
      return [];
    }

    this.log(`[Scout] Triaging ${unprocessed.length} unprocessed items...`);

    // Triage all items in parallel
    const triaged = await Promise.all(
      unprocessed.map(async (item) => {
        const result = await this.triageItem(item.title, item.summary);
        if (!result) {
          this.log(`[Scout] Rejected: "${item.title}"`);
          return null;
        }
        return { item, result };
      })
    );

    // Group by pillar, capped at ARTICLES_PER_PILLAR each
    const byPillar: Record<Pillar, ScoutItem[]> = {
      anime: [],
      gaming: [],
      infotainment: [],
      manga: [],
      toys: [],
    };

    for (const entry of triaged) {
      if (!entry) continue;
      const { item, result } = entry;
      const bucket = byPillar[result.pillar];
      if (bucket.length < ARTICLES_PER_PILLAR) {
        bucket.push({
          title: item.title,
          link: item.link,
          summary: item.summary,
          pillar: result.pillar,
          translationNotes: result.translation_notes,
        });
      }
    }

    const selected: ScoutItem[] = [];
    for (const pillar of PILLARS) {
      for (const item of byPillar[pillar]) {
        this.log(`[Scout] Selected: "${item.title}" [${pillar}]`);
        selected.push(item);
      }
      if (byPillar[pillar].length < ARTICLES_PER_PILLAR) {
        this.log(
          `[Scout] Warning: Only found ${byPillar[pillar].length}/${ARTICLES_PER_PILLAR} items for ${PILLAR_LABELS[pillar]}`
        );
      }
    }

    this.log(`[Scout] Triage complete. Found ${selected.length} candidate articles.`);
    return selected;
  }
}
