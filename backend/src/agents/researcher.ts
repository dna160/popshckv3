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
import { crawlUrl } from '../services/crawler';
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
    const prompt = `You are a senior editor at an Asian pop-culture newsroom covering anime, gaming, manga, toys, and infotainment.

Article Title: "${item.title}"
Article Summary: "${item.summary}"
Declared Pillar: "${pillarLabel}"

**DEVELOPER/ORIGIN POLICY — Gaming pillar:**
APPROVE games and gaming content from Japanese, Chinese, AND Korean developers/publishers.
This includes (but is not limited to): HoYoverse (Genshin Impact, Honkai), miHoYo, NEXON, Netmarble, Krafton, NetEase, and any gacha/anime-style game regardless of country of origin.
Only REJECT a gaming article if the game has zero connection to anime/manga aesthetics or Asian pop-culture (e.g. Western AAA shooters, sports sims).

Determine:
1. Is this article genuinely relevant to the "${pillarLabel}" pillar using the policy above?
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
   * Extract key facts from article title, summary, and optionally crawled full content.
   */
  private async extractFacts(item: ScoutItem, crawledContent?: string): Promise<string[]> {
    const sourceBlock = crawledContent && crawledContent.length > 0
      ? `Article Full Content (crawled):\n${crawledContent}`
      : `Article Summary: "${item.summary}"`;

    const prompt = `You are a research assistant for a Japanese pop-culture newsroom.

Extract 5–8 key facts from this article that a copywriter can use to write an accurate article.
Be specific, factual, and concise. Prioritise facts from the full content when available.

Article Title: "${item.title}"
${sourceBlock}
Content Pillar: "${PILLAR_LABELS[item.pillar]}"

Respond in JSON format:
{
  "facts": ["fact1", "fact2", "fact3", ...]
}`;

    try {
      const raw = await chat([{ role: 'user', content: prompt }], { temperature: 0.3, maxTokens: 500 });

      try {
        const result = parseJsonResponse<{ facts: string[] }>(raw);
        if (result && Array.isArray(result.facts) && result.facts.length > 0) {
          return result.facts;
        }
        // Fallback if facts array is empty or missing
        throw new Error('LLM returned empty or malformed facts array');
      } catch (parseErr) {
        // JSON parse failed or structure invalid — log and fall back to title + summary
        this.log(
          `[Researcher] Fact extraction JSON parse failed for "${item.title}": ${(parseErr as Error).message}. Using title + summary as fallback.`
        );
        return [item.title, item.summary.slice(0, 200)];
      }
    } catch (err) {
      // LLM call itself failed (network, timeout, etc.)
      this.log(`[Researcher] Fact extraction LLM call failed: ${(err as Error).message}`);
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

        // Filter to unseen, valid URLs, then evaluate all in parallel
        const candidates = images.filter(
          (img) => img.imageUrl.startsWith('http') && !triedUrls.has(img.imageUrl)
        );
        for (const img of candidates) triedUrls.add(img.imageUrl);

        const results = await Promise.all(
          candidates.map(async (img) => ({
            img,
            isRelevant: await evaluateImageRelevance(img.imageUrl, title, PILLAR_LABELS[pillar]),
          }))
        );

        for (const { img, isRelevant } of results) {
          if (approved.length >= REQUIRED_IMAGES) break;
          if (isRelevant) {
            approved.push({
              url: img.imageUrl,
              alt: img.title || `${PILLAR_LABELS[pillar]} - ${title}`,
              isFeatured: approved.length === 0,
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

    // Crawl the source URL for full article content
    this.log(`[Researcher] Crawling source: ${item.link}`);
    const crawledContent = await crawlUrl(item.link);
    if (crawledContent.length > 0) {
      this.log(`[Researcher] Crawl succeeded (${crawledContent.length} chars) for "${item.title}"`);
    } else {
      this.log(`[Researcher] Crawl returned no content — falling back to RSS summary for "${item.title}"`);
    }

    // Extract facts (uses crawled content when available, RSS summary otherwise)
    const facts = await this.extractFacts(item, crawledContent);

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
    this.log(`[Researcher] Beginning research on ${items.length} articles in parallel...`);

    const results = await Promise.all(items.map((item) => this.researchItem(item)));

    const approved: ResearchedItem[] = [];
    const rejected: ScoutItem[] = [];

    for (let i = 0; i < results.length; i++) {
      if (results[i].approved) {
        approved.push(results[i]);
      } else {
        rejected.push(items[i]);
      }
    }

    this.log(`[Researcher] Research complete. Approved: ${approved.length}, Rejected: ${rejected.length}`);
    return { approved, rejected };
  }
}
