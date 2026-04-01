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
import { marked } from 'marked';
import type { Pillar, ResearchedItem, DraftArticle, ArticleImage } from '../../../shared/types';
import { PILLAR_LABELS } from '../../../shared/types';

const MIN_WORDS = 300;
const MAX_WORDS = 400;

export class Copywriter {
  private log: (msg: string) => void;

  constructor(log: (msg: string) => void = console.log) {
    this.log = log;
  }

  private getToneGuide(pillar: Pillar): string {
    const tones: Record<Pillar, string> = {
      anime: `Enthusiastic, fan-centric, passionate. Use anime fandom terminology naturally.
Appeal to both casual viewers and dedicated otaku. Reference comparable shows when relevant.
Avoid spoilers without spoiler warnings. Celebrate announcements and news with genuine excitement.`,

      gaming: `Analytical yet accessible. Balance technical detail with broad appeal.
Cover both hardcore gamers and casual players. Reference Japanese gaming heritage when relevant.
Include context about developer history, gameplay mechanics, and market impact.`,

      infotainment: `Conversational, curious, warm. Focus on human interest angles.
Make Japanese culture accessible to international readers without being condescending.
Use storytelling elements. Balance informative content with entertainment value.`,

      manga: `Knowledgeable and reverent. Treat manga as the art form it is.
Reference mangaka (creators) by name, discuss artistic style and narrative craft.
Connect manga to its cultural context. Appeal to collectors and casual readers alike.`,

      toys: `Collector-focused, detail-oriented, excited. Understand the significance of limited editions.
Mention scale, manufacturer, release windows, pricing context when available.
Speak to both display collectors and play-value enthusiasts.`,
    };
    return tones[pillar];
  }

  private countWords(text: string): number {
    return text.trim().split(/\s+/).filter((w) => w.length > 0).length;
  }

  /**
   * Build the markdown content with intelligent image placement.
   */
  private buildMarkdownWithImages(bodyText: string, images: ArticleImage[]): string {
    const lines = bodyText.split('\n');
    const totalLines = lines.length;

    // Image placement strategy:
    // - Featured image: at the top (before first paragraph)
    // - Image 2: after ~40% of content
    // - Image 3: after ~75% of content

    const featuredImg = images.find((img) => img.isFeatured);
    const nonFeaturedImgs = images.filter((img) => !img.isFeatured);

    const insertions: Array<{ lineIndex: number; markdown: string }> = [];

    if (featuredImg) {
      insertions.push({
        lineIndex: 0,
        markdown: `![${featuredImg.alt}](${featuredImg.url})\n*Featured: ${featuredImg.alt}*\n`,
      });
    }

    if (nonFeaturedImgs[0]) {
      const pos = Math.floor(totalLines * 0.4);
      insertions.push({
        lineIndex: pos,
        markdown: `\n![${nonFeaturedImgs[0].alt}](${nonFeaturedImgs[0].url})\n`,
      });
    }

    if (nonFeaturedImgs[1]) {
      const pos = Math.floor(totalLines * 0.75);
      insertions.push({
        lineIndex: pos,
        markdown: `\n![${nonFeaturedImgs[1].alt}](${nonFeaturedImgs[1].url})\n`,
      });
    }

    // Sort insertions in reverse order to avoid index shifting
    insertions.sort((a, b) => b.lineIndex - a.lineIndex);

    for (const insertion of insertions) {
      lines.splice(insertion.lineIndex, 0, insertion.markdown);
    }

    return lines.join('\n');
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
    const toneGuide = this.getToneGuide(item.pillar);

    const factsBlock = item.facts.length > 0
      ? `\nKey facts to incorporate:\n${item.facts.map((f, i) => `${i + 1}. ${f}`).join('\n')}`
      : '';

    const feedbackBlock = editorFeedback
      ? `\n\nIMPORTANT - Editor feedback to address:\n${editorFeedback}\nMake sure every point of feedback is resolved in your rewrite.`
      : '';

    const prompt = `You are a professional copywriter specializing in "${pillarLabel}" content for a Japanese pop-culture newsroom.

Tone Guide:
${toneGuide}

Write an article based on the following:
Title: "${item.title}"
Source: ${item.link}
${factsBlock}
${feedbackBlock}

Requirements:
- Write EXACTLY between ${MIN_WORDS} and ${MAX_WORDS} words (body text only, not counting image captions)
- Use markdown formatting with clear headers (## for sections)
- Write an engaging introduction paragraph
- Include 2–3 body sections with subheadings
- End with a forward-looking conclusion
- Do NOT include image placeholders — those will be added separately
- Do NOT fabricate specific dates, numbers, or quotes not supported by the provided facts
- Write in English, targeting an international English-speaking audience interested in Japanese pop culture

Output ONLY the article body text in markdown. No meta-commentary, no word count notes.`;

    const bodyText = await chat(
      [{ role: 'user', content: prompt }],
      { temperature: 0.75, maxTokens: 800 }
    );

    const wordCount = this.countWords(bodyText);
    this.log(`[Copywriter] Draft written. Word count: ${wordCount}`);

    // Build markdown with images inserted
    const markdownWithImages = this.buildMarkdownWithImages(bodyText, item.images);

    // Convert to HTML for WordPress
    const contentHtml = await marked.parse(markdownWithImages);

    return {
      title: item.title,
      pillar: item.pillar,
      sourceUrl: item.link,
      content: markdownWithImages,
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
