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

const MIN_WORDS = 200;
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
The entire article, **ESPECIALLY THE HEADLINE**, MUST be written in natural, fluent INDONESIAN (Bahasa Indonesia).
**DO NOT** copy the original Japanese headline verbatim. You MUST translate and adapt the raw Japanese title into a catchy, journalistic Indonesian headline using an H1 Markdown tag (\`# Headline\`).

**INPUTS YOU WILL RECEIVE:**
1. [Content Pillar]: The category of the article (Anime / Gaming / Infotainment / Manga / Toys).
2. [Extracted Facts]: The raw facts extracted by the Researcher agent.
3. [Translation Notes]: Crucial localization notes provided by the Scout. Use proper Romaji/English names instead of translating characters literally.
4. [Images]: Three (3) image URLs and their descriptions.
5. [Editor Notes]: (Optional) Critique from the Editor.

[Content Pillar]: ${pillarLabel}
[Title]: "${item.title}"
[Source]: ${item.link}
${factsBlock}
${translationBlock}
${imagesBlock}
${feedbackBlock}

**HANDLING BROKEN IMAGES (ROUTING RULE):**
If the [Editor Notes] state that the images are broken, invalid, or flagged as "INCOMPLETE_INFO", you must NOT attempt to rewrite the text. Instead, you must immediately output the exact string: \`SYSTEM_ROUTE_TO_RESEARCHER: NEW_IMAGES_REQUIRED\`. This will instruct the backend to ping the Researcher for new image links.

**STRICT WRITING RULES:**
1. **Headline:** Must be Bahasa Indonesia. (e.g., \`# [Indonesian Headline Here]\`).
2. **Word Count:** HARD LIMIT — 200 to 400 words. Count your words before outputting. If you are over 400, cut sentences. If you are under 200, expand an existing section. Do NOT exceed 400 words under any circumstances.
3. **Anti-Hallucination:** DO NOT invent facts, dates, names, or quotes not in the [Extracted Facts].
4. **Format:** Pure Markdown. Image 1 must be placed right below the headline with the alt-text \`![featured](URL)\`. Images 2 and 3 should be placed intelligently within the body.
5. **Closing / Call-to-Action (MANDATORY):** Every article MUST end with a punchy 1–2 sentence closing that matches the pillar's context. Use informal, conversational Bahasa Indonesia. Examples:
   - Toys / pre-order available: *"Ayo tunggu apa lagi — kamu bisa pre-order sekarang di [link sumber]!"*
   - Toys / no pre-order yet: *"Pantau terus info resminya ya, jangan sampai kehabisan!"*
   - Anime: *"Siap-siap nonton! Tandai tanggalnya sekarang biar nggak kelewatan."*
   - Gaming: *"Udah nggak sabar main? Drop komentar di bawah dan ajak teman-teman kamu!"*
   - Manga: *"Sudah baca chapter terbarunya? Kasih tau kita pendapat kamu!"*
   - Infotainment: *"Ikuti terus perkembangannya — ini baru permulaan."*

**REVISION RULES (when [Editor Notes] are present):**
- DO NOT add new paragraphs or new sections to fix a word count problem.
- Instead, RESTRUCTURE and REWRITE existing sentences to be tighter or richer.
- Fix only what the [Editor Notes] call out — do not rewrite unrelated sections.
- Word count MUST remain between 300–400 after revision.

**TONE GUIDELINES BASED ON [Content Pillar]:**
- **Japanese Anime:** Enthusiastic and hype-focused. Celebrate the creators/studios. Use casual, welcoming greetings typical of Indonesian anime communities.
- **Japanese Gaming:** Casual, fun, and accessible. Highlight gameplay features, community updates, or release news using familiar Indonesian gamer terminology.
- **Japanese Infotainment:** Journalistic, factual, straightforward, and professional. Best for cultural news, trends, or serious topics.
- **Japanese Manga:** Slightly literary and analytical. Focus on storytelling appreciation, art quality, and publishing industry news.
- **Japanese Toys/Collectibles:** Collector-focused. Highly detailed regarding specifications, craftsmanship, exclusivity, and pricing. Always include pre-order or purchase links in the CTA if the source URL is a product/order page.

If no image errors are present, write the article matching the tone of the [Content Pillar].

Output ONLY the article in markdown. No meta-commentary, no word count notes.`;

    const articleText = await chat(
      [{ role: 'user', content: prompt }],
      { temperature: 0.75, maxTokens: 800 }
    );

    // Detect routing signal — Copywriter is telling pipeline to fetch new images
    if (articleText.trim().startsWith('SYSTEM_ROUTE_TO_RESEARCHER')) {
      this.log(`[Copywriter] Routing signal detected — new images required for "${item.title}"`);
    }

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
