/**
 * Agent 1: RSS Feeder & Triage (The Scout)
 *
 * Responsibilities:
 * - Poll RSS feeds for all 5 pillars
 * - Deduplicate against ProcessedUrl DB table
 * - Select exactly 2 articles per pillar (10 total per run)
 * - Return candidate items for the Researcher
 */

import { PrismaClient } from '@prisma/client';
import { fetchPillarFeeds } from '../services/rss';
import { chat } from '../services/llm';
import type { Pillar, ScoutItem } from '../../../shared/types';
import { PILLARS, PILLAR_LABELS } from '../../../shared/types';

const ARTICLES_PER_PILLAR = 2;

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
   * Use Grok to evaluate whether an RSS item belongs to the given pillar.
   * Returns true if the topic is relevant.
   */
  private async evaluateTopicRelevance(
    title: string,
    summary: string,
    pillar: Pillar
  ): Promise<boolean> {
    const pillarLabel = PILLAR_LABELS[pillar];
    const prompt = `You are a content triage specialist for a Japanese pop-culture newsroom.

Evaluate whether the following article topic belongs to the "${pillarLabel}" content pillar.

Article Title: "${title}"
Article Summary: "${summary}"

The "${pillarLabel}" pillar covers: ${this.pillarDescription(pillar)}

Respond with ONLY "YES" if clearly relevant, or "NO" if not relevant or ambiguous.`;

    try {
      const response = await chat(
        [{ role: 'user', content: prompt }],
        { temperature: 0, maxTokens: 10 }
      );
      return response.trim().toUpperCase() === 'YES';
    } catch (err) {
      this.log(`[Scout] LLM triage failed for "${title}": ${(err as Error).message}`);
      // Default to accepting if LLM is unavailable
      return true;
    }
  }

  private pillarDescription(pillar: Pillar): string {
    const descriptions: Record<Pillar, string> = {
      anime: 'Japanese animation series, anime news, character reveals, anime studios, streaming releases, voice actors, anime adaptations',
      gaming: 'Japanese video games, Nintendo, Sony PlayStation, gaming hardware from Japan, game releases, Japanese game developers',
      infotainment: 'Japanese pop culture news, celebrity gossip in Japan, Japanese entertainment industry, Japan lifestyle, food, travel, viral Japan stories',
      manga: 'Japanese comic books/manga, manga artists, manga releases, manga adaptations, light novels, webtoons from Japan',
      toys: 'Japanese action figures, collectibles, Gundam, Funko-style toys from Japan, limited edition Japanese merchandise, trading cards, figurines',
    };
    return descriptions[pillar];
  }

  /**
   * Fetch and select candidate articles for a single pillar.
   * Returns up to `needed` items that are not yet processed and are relevant.
   */
  async fetchPillarCandidates(
    pillar: Pillar,
    needed: number,
    rejectedUrls: Set<string> = new Set()
  ): Promise<ScoutItem[]> {
    this.log(`[Scout] Fetching candidates for pillar: ${PILLAR_LABELS[pillar]}`);

    const items = await fetchPillarFeeds(pillar);

    // Evaluate all candidates in parallel — DB checks + LLM triage fire simultaneously
    const candidates = items.filter((item) => !rejectedUrls.has(item.link));

    const evaluated = await Promise.all(
      candidates.map(async (item) => {
        const alreadyProcessed = await this.isProcessed(item.link);
        if (alreadyProcessed) {
          this.log(`[Scout] Skipping already-processed: ${item.link}`);
          return null;
        }
        const relevant = await this.evaluateTopicRelevance(item.title, item.summary, pillar);
        if (!relevant) {
          this.log(`[Scout] Rejected irrelevant topic: "${item.title}"`);
          return null;
        }
        return item;
      })
    );

    const selected: ScoutItem[] = evaluated
      .filter((item): item is NonNullable<typeof item> => item !== null)
      .slice(0, needed)
      .map((item) => ({
        title: item.title,
        link: item.link,
        summary: item.summary,
        pillar,
      }));

    for (const item of selected) {
      this.log(`[Scout] Selected: "${item.title}" [${pillar}]`);
    }

    if (selected.length < needed) {
      this.log(`[Scout] Warning: Only found ${selected.length}/${needed} items for ${pillar}`);
    }

    return selected;
  }

  /**
   * Main Scout run: collect exactly ARTICLES_PER_PILLAR per pillar.
   * Accepts a set of rejected URLs from the Researcher to retry with different articles.
   */
  async run(rejectedUrls: Set<string> = new Set()): Promise<ScoutItem[]> {
    this.log('[Scout] Starting RSS triage run...');
    const allItems: ScoutItem[] = [];

    // Process pillars in parallel
    const pillarPromises = PILLARS.map((pillar) =>
      this.fetchPillarCandidates(pillar, ARTICLES_PER_PILLAR, rejectedUrls)
    );

    const results = await Promise.allSettled(pillarPromises);

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const pillar = PILLARS[i];
      if (result.status === 'fulfilled') {
        allItems.push(...result.value);
      } else {
        this.log(`[Scout] Failed to fetch pillar ${pillar}: ${result.reason}`);
      }
    }

    this.log(`[Scout] Triage complete. Found ${allItems.length} candidate articles.`);
    return allItems;
  }
}
