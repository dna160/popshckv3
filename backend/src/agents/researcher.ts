/**
 * Agent 2: Investigative Agent (The Researcher)
 *
 * Responsibilities:
 * - Evaluate Scout's topics for pillar relevance (second-pass deep evaluation)
 * - Source images via SERPER
 * - Evaluate image relevance using Grok vision
 * - Return 3 highly-relevant images per article
 * - Extract supporting facts for the Copywriter
 */

import { chat, evaluateImageRelevance, parseJsonResponse } from '../services/llm';
import { searchImages, buildImageQuery } from '../services/serper';
import type { Pillar, ScoutItem, ResearchedItem, ArticleImage } from '../../../shared/types';
import { PILLAR_LABELS } from '../../../shared/types';

const REQUIRED_IMAGES = 3;
const MAX_IMAGE_SEARCH_ROUNDS = 5;

export class Researcher {
  private log: (msg: string) => void;

  constructor(log: (msg: string) => void = console.log) {
    this.log = log;
  }

  /**
   * Deep evaluate whether an article is relevant to its declared pillar.
   * Returns { approved: boolean; reason?: string }
   */
  private async deepEvaluateTopic(item: ScoutItem): Promise<{ approved: boolean; reason: string }> {
    const pillarLabel = PILLAR_LABELS[item.pillar];
    const prompt = `You are a senior editor at a Japanese pop-culture newsroom. Perform a thorough evaluation.

Article Title: "${item.title}"
Article Summary: "${item.summary}"
Declared Pillar: "${pillarLabel}"

Determine:
1. Is this article genuinely relevant to the "${pillarLabel}" pillar?
2. Is the topic interesting and newsworthy for our audience?
3. Is there enough information to write a 300–400 word article?

Respond in JSON format:
{
  "approved": true/false,
  "reason": "brief explanation"
}`;

    try {
      const raw = await chat([{ role: 'user', content: prompt }], { temperature: 0, maxTokens: 200 });
      const result = parseJsonResponse<{ approved: boolean; reason: string }>(raw);
      return result;
    } catch (err) {
      this.log(`[Researcher] Topic evaluation failed for "${item.title}": ${(err as Error).message}`);
      return { approved: true, reason: 'Evaluation failed, defaulting to approved' };
    }
  }

  /**
   * Extract key facts from article title and summary to help the Copywriter.
   */
  private async extractFacts(item: ScoutItem): Promise<string[]> {
    const prompt = `You are a research assistant for a Japanese pop-culture newsroom.

Extract 5–8 key facts from this article that a copywriter can use to write an accurate article.
Be specific, factual, and concise.

Article Title: "${item.title}"
Article Summary: "${item.summary}"
Content Pillar: "${PILLAR_LABELS[item.pillar]}"

Respond in JSON format:
{
  "facts": ["fact1", "fact2", "fact3", ...]
}`;

    try {
      const raw = await chat([{ role: 'user', content: prompt }], { temperature: 0.3, maxTokens: 500 });
      const result = parseJsonResponse<{ facts: string[] }>(raw);
      return result.facts || [];
    } catch (err) {
      this.log(`[Researcher] Fact extraction failed: ${(err as Error).message}`);
      return [item.title, item.summary.slice(0, 200)];
    }
  }

  /**
   * Find 3 highly relevant images for an article using SERPER + Grok vision.
   * Runs multiple search rounds with different queries until quota is met.
   */
  async findImages(
    title: string,
    pillar: Pillar,
    existingUrls: Set<string> = new Set()
  ): Promise<ArticleImage[]> {
    const approved: ArticleImage[] = [];
    const triedUrls = new Set<string>(existingUrls);

    const baseQuery = buildImageQuery(title, pillar);
    const queryVariants = [
      baseQuery,
      `${PILLAR_LABELS[pillar]} ${title.split(' ').slice(0, 4).join(' ')}`,
      `${baseQuery} official art`,
      `${PILLAR_LABELS[pillar]} illustration`,
      `Japan ${pillar} popular`,
    ];

    for (let round = 0; round < MAX_IMAGE_SEARCH_ROUNDS && approved.length < REQUIRED_IMAGES; round++) {
      const query = queryVariants[round % queryVariants.length];
      this.log(`[Researcher] Image search round ${round + 1}: "${query}"`);

      try {
        const images = await searchImages(query, 15);

        for (const img of images) {
          if (approved.length >= REQUIRED_IMAGES) break;
          if (triedUrls.has(img.imageUrl)) continue;
          if (!img.imageUrl.startsWith('http')) continue;

          triedUrls.add(img.imageUrl);

          const isRelevant = await evaluateImageRelevance(img.imageUrl, title, PILLAR_LABELS[pillar]);
          if (isRelevant) {
            approved.push({
              url: img.imageUrl,
              alt: img.title || `${PILLAR_LABELS[pillar]} - ${title}`,
              isFeatured: approved.length === 0, // First approved image is featured
              sourceQuery: query,
            });
            this.log(`[Researcher] Approved image ${approved.length}/${REQUIRED_IMAGES}: ${img.imageUrl}`);
          }
        }
      } catch (err) {
        this.log(`[Researcher] Image search failed (round ${round + 1}): ${(err as Error).message}`);
      }
    }

    if (approved.length < REQUIRED_IMAGES) {
      this.log(`[Researcher] Warning: Only found ${approved.length}/${REQUIRED_IMAGES} images for "${title}"`);
    }

    return approved;
  }

  /**
   * Research a single Scout item.
   * Returns a ResearchedItem with approval status, facts, and images.
   */
  async researchItem(item: ScoutItem): Promise<ResearchedItem> {
    this.log(`[Researcher] Researching: "${item.title}" [${item.pillar}]`);

    // Deep topic evaluation
    const { approved, reason } = await this.deepEvaluateTopic(item);

    if (!approved) {
      this.log(`[Researcher] Rejected: "${item.title}" — ${reason}`);
      return {
        ...item,
        images: [],
        facts: [],
        approved: false,
        rejectionReason: reason,
      };
    }

    // Extract facts
    const facts = await this.extractFacts(item);

    // Find images
    const images = await this.findImages(item.title, item.pillar);

    return {
      ...item,
      images,
      facts,
      approved: true,
    };
  }

  /**
   * Research all Scout items.
   * Returns researched items, with rejected ones marked for Scout feedback loop.
   */
  async run(items: ScoutItem[]): Promise<{
    approved: ResearchedItem[];
    rejected: ScoutItem[];
  }> {
    this.log(`[Researcher] Beginning research on ${items.length} articles...`);

    const approved: ResearchedItem[] = [];
    const rejected: ScoutItem[] = [];

    // Research items sequentially to avoid rate limits
    for (const item of items) {
      const result = await this.researchItem(item);
      if (result.approved) {
        approved.push(result);
      } else {
        rejected.push(item);
      }
    }

    this.log(`[Researcher] Research complete. Approved: ${approved.length}, Rejected: ${rejected.length}`);
    return { approved, rejected };
  }
}
