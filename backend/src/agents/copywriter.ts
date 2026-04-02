/**
 * Agent 3: Copywriting Agent (The Pillar Expert)
 *
 * Responsibilities:
 * - Write 300–400 word articles tailored to each pillar's tone
 * - Intelligently place 3 images for best context
 * - Format featured image for WordPress standards
 * - Incorporate facts from the Researcher
 */

import { chat } from '../services/llm';
import type { ResearchedItem, DraftArticle, ArticleImage } from '../../../shared/types';
import { PILLAR_LABELS } from '../../../shared/types';

const MIN_WORDS = 300;
const MAX_WORDS = 400;

export class Copywriter {
  private log: (msg: string) => void;

  constructor(log: (msg: string) => void = console.log) {
    this.log = log;
  }


  private countWords(text: string): number {
    return text.trim().split(/\s+/).filter((w) => w.length > 0).length;
  }

  /**
   * Write an article draft for a researched item.
   */
  async writeDraft(
    item: ResearchedItem,
    editorFeedback?: string
  ): Promise<DraftArticle> {
    this.log(`[Copywriter] Writing draft: "${item.title}" [${item.pillar}]`);

    const pillarLabel = PILLAR_LABELS[item.pillar];

    const factsBlock = item.facts.length > 0
      ? `\n[Extracted Facts]:\n${item.facts.map((f, i) => `${i + 1}. ${f}`).join('\n')}`
      : '\n[Extracted Facts]: (No additional facts provided — base the article on the title and source only.)';

    const translationBlock = item.translationNotes
      ? `\n[Translation Notes]:\n${item.translationNotes}`
      : '';

    const imagesBlock = item.images.length > 0
      ? `\n[Images]:\n${item.images.map((img, i) => `Image ${i + 1}: ${img.url}\nDescription: ${img.alt}`).join('\n')}`
      : '';

    const feedbackBlock = editorFeedback
      ? `\n[Editor Notes]:\n${editorFeedback}`
      : '';

    const prompt = `You are the **Master Copywriter Agent** for a premium Japanese pop-culture news portal. Your job is to weave raw facts into engaging, high-quality news articles.

*** CRITICAL LANGUAGE DIRECTIVE ***
Although these instructions are in English, **THE FINAL ARTICLE MUST BE WRITTEN ENTIRELY IN NATURAL, FLUENT INDONESIAN (Bahasa Indonesia), INCLUDING THE HEADLINE.** Do not sound like a robotic translation. Write like a native Indonesian pop-culture journalist. Do not output English text unless it is a proper noun, title, or Markdown syntax.

**INPUTS:**

[Content Pillar]: ${pillarLabel}

[Title]: "${item.title}"
[Source]: ${item.link}
${factsBlock}
${translationBlock}
${imagesBlock}
${feedbackBlock}

**STRICT WRITING RULES:**
1. **Headline:** You MUST write a catchy headline in Bahasa Indonesia at the top of the article using an H1 Markdown tag (\`# Headline\`).
2. **Word Count:** The body of the article MUST be between ${MIN_WORDS} and ${MAX_WORDS} words.
3. **Anti-Hallucination:** DO NOT invent facts, dates, names, or quotes that are not in the [Extracted Facts]. Expand the prose to be engaging, but keep the substance 100% accurate to the source.
4. **Format:** Use pure Markdown. Do not include conversational filler (e.g., do not write "Here is your article:").
5. **Translation Notes:** You MUST use the proper Romaji/English names from [Translation Notes] instead of translating Japanese characters literally.

**IMAGE PLACEMENT RULES:**
You must insert all three images into the article using the standard Markdown format: \`![alt text](URL)\`.
- **Image 1 (Mandatory):** Place this directly beneath your H1 Headline, before the first paragraph. The alt-text MUST be exactly \`featured\`. Example: \`![featured](IMAGE_1_URL)\`
- **Image 2 & Image 3:** Insert these intelligently within the body of the article (e.g., after a new heading or relevant paragraph). Use descriptive Indonesian alt-text based on the image context.

**TONE GUIDELINES BASED ON [Content Pillar]:**
- **Japanese Anime:** Enthusiastic and hype-focused. Celebrate the creators/studios. Use casual, welcoming greetings typical of Indonesian anime communities.
- **Japanese Gaming:** Casual, fun, and accessible. Highlight gameplay features, community updates, or release news using familiar Indonesian gamer terminology.
- **Japanese Infotainment:** Journalistic, factual, straightforward, and professional. Best for cultural news, trends, or serious topics.
- **Japanese Manga:** Slightly literary and analytical. Focus on storytelling appreciation, art quality, and publishing industry news.
- **Japanese Toys/Collectibles:** Collector-focused. Highly detailed regarding specifications, craftsmanship, exclusivity, and pricing.

If [Editor Notes] are provided, you MUST read the critique carefully and rewrite the article to fix the mentioned issues so it passes the next review.

Output ONLY the article in markdown. No meta-commentary, no word count notes.`;

    const articleText = await chat(
      [{ role: 'user', content: prompt }],
      { temperature: 0.75, maxTokens: 800 }
    );

    const wordCount = this.countWords(articleText);
    this.log(`[Copywriter] Draft written. Word count: ${wordCount}`);

    return {
      title: item.title,
      pillar: item.pillar,
      sourceUrl: item.link,
      content: articleText,
      images: item.images,
      wordCount,
    };
  }

  /**
   * Rewrite a draft with editor feedback, optionally using new images.
   */
  async rewrite(
    item: ResearchedItem,
    editorFeedback: string,
    newImages?: ArticleImage[]
  ): Promise<DraftArticle> {
    this.log(`[Copywriter] Rewriting draft with feedback: "${item.title}"`);

    const updatedItem: ResearchedItem = {
      ...item,
      images: newImages || item.images,
    };

    return this.writeDraft(updatedItem, editorFeedback);
  }
}
