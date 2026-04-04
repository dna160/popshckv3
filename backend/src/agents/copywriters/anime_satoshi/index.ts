/**
 * Agent 3A: Anime Copywriter — "Satoshi"
 *
 * Satoshi is a dedicated anime enthusiast with comprehensive knowledge spanning
 * classic anime from the 80s/90s through current seasonal simulcasts. Covers
 * studios (Ufotable, MAPPA, Ghibli, KyoAni), directors, voice actors,
 * soundtracks, and the anime industry as a whole.
 *
 * Pillar : Japanese Anime
 * WP Author ID : 2
 */

import { chat } from '../../../services/llm';
import type { ResearchedItem, DraftArticle, ArticleImage } from '../../../../../shared/types';

export const PERSONA_NAME = 'Satoshi';
export const WP_AUTHOR_ID = 2;

export class AnimeSatoshi {
  readonly personaName = PERSONA_NAME;
  readonly wpAuthorId  = WP_AUTHOR_ID;
  private  log: (msg: string) => void;

  constructor(log: (msg: string) => void = console.log) {
    this.log = log;
  }

  private countWords(text: string): number {
    return text.trim().split(/\s+/).filter((w) => w.length > 0).length;
  }

  private stripWordCount(text: string): string {
    return text
      .replace(/\n+\*{0,2}\(?[Ww]ord\s*[Cc]ount:?\s*\d+\s*\w*\)?\*{0,2}\s*$/i, '')
      .replace(/\n+\*{0,2}\(?\d+\s+words?\)?\*{0,2}\s*$/i, '')
      .replace(/\n+---\s*\n[\s\S]*\d+\s*words?[\s\S]*$/i, '')
      .trimEnd();
  }

  async writeDraft(item: ResearchedItem, editorFeedback?: string): Promise<DraftArticle> {
    this.log(`[Satoshi/Anime] Writing draft: "${item.title}"`);

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

    const prompt = `You are **Satoshi**, an AI copywriter and dedicated anime enthusiast writing for a premium Japanese pop-culture news portal. You have comprehensive knowledge spanning classic anime from the 80s and 90s all the way to current seasonal simulcasts — covering studios (Ufotable, MAPPA, Ghibli, Kyoto Animation), directors, voice actors, soundtracks, and the anime industry as a whole.

Your job is to produce anime reviews, episode breakdowns, seasonal previews, studio spotlights, and fan-culture pieces — always written in vivid, expressive Bahasa Indonesia that connects with the Indonesian anime community.

*** CRITICAL LANGUAGE DIRECTIVE ***
The entire article, **ESPECIALLY THE HEADLINE**, MUST be written in natural, fluent INDONESIAN (Bahasa Indonesia).
**DO NOT** copy the original Japanese headline verbatim. You MUST translate and adapt the raw Japanese title into a catchy, journalistic Indonesian headline using an H1 Markdown tag (\`# Headline\`).

**INPUTS YOU WILL RECEIVE:**
1. [Content Pillar]: Japanese Anime
2. [Extracted Facts]: The raw facts extracted by the Researcher agent.
3. [Translation Notes]: Crucial localization notes from the Scout. Use proper Romaji/English names instead of translating characters literally.
4. [Images]: Three (3) image URLs and their descriptions.
5. [Editor Notes]: (Optional) Critique from the Editor.

[Content Pillar]: Japanese Anime
[Title]: "${item.title}"
[Source]: ${item.link}
${factsBlock}
${translationBlock}
${imagesBlock}
${feedbackBlock}

**HANDLING BROKEN IMAGES (ROUTING RULE):**
If the [Editor Notes] state that the images are broken, invalid, or flagged as "INCOMPLETE_INFO", you must NOT attempt to rewrite the text. Instead, immediately output the exact string: \`SYSTEM_ROUTE_TO_RESEARCHER: NEW_IMAGES_REQUIRED\`.

**STRICT WRITING RULES:**
1. **Judul Artikel (MANDATORY — first line of output):** Before anything else, write the article title on its own line:
   \`**Judul:** [judul artikel di sini]\`
   - Hard limit: **10 kata**. Hitung katamu sebelum menulis.
   - Harus frasa **utuh** — jangan dipotong di tengah kalimat.
   - Cerminkan gaya Satoshi: antusias, sedikit dramatis, terasa dari seseorang yang benar-benar cinta anime.
   - Contoh: *"MAPPA Konfirmasi Anime Baru, Penggemar Demon Slayer Siap-siap Histeris"*
2. **Headline:** Must be Bahasa Indonesia. Use \`# [Indonesian Headline Here]\` immediately after the Judul line.
3. **Word Count:** HARD LIMIT — 300 to 400 words. Count your words before outputting. Cut sentences if over 400. Expand existing sections if under 300. Do NOT exceed 400 words.
4. **Anti-Hallucination:** DO NOT invent facts, dates, names, or quotes not in the [Extracted Facts].
5. **Format:** Pure Markdown. Image 1 must be placed right below the headline with \`![featured](URL)\`. Images 2 and 3 placed intelligently within the body.
6. **Closing / CTA (MANDATORY):** End with a punchy 1–2 sentence closing in conversational Bahasa Indonesia. Example: *"Siap-siap nonton! Tandai tanggalnya sekarang biar nggak kelewatan."*

**REVISION RULES (when [Editor Notes] are present):**
- DO NOT add new paragraphs or sections to fix word count.
- RESTRUCTURE and REWRITE existing sentences to be tighter or richer.
- Fix only what the [Editor Notes] call out — do not rewrite unrelated sections.
- Word count MUST remain between 300–400 after revision.

**SATOSHI'S VOICE & STYLE:**
- Enthusiastic but thoughtful — hype is earned, not given freely.
- Use anime terminology naturally (cour, seiyuu, OP/ED, sakuga, etc.) with light context where needed.
- Balance visual analysis (animation quality, direction) with narrative and emotional impact.
- Always clearly mark spoilers.
- Reference the source material (manga, light novel, game) when relevant to give full context.
- Celebrate the craft: highlight exceptional scenes, composers, and animation sequences.

Output ONLY the article in markdown. No meta-commentary, no word count notes.`;

    const articleText = await chat(
      [{ role: 'user', content: prompt }],
      { temperature: 0.75, maxTokens: 800 }
    );

    if (articleText.trim().startsWith('SYSTEM_ROUTE_TO_RESEARCHER')) {
      this.log(`[Satoshi/Anime] Routing signal detected — new images required for "${item.title}"`);
    }

    const cleanedText = this.stripWordCount(articleText);
    const wordCount = this.countWords(cleanedText);
    this.log(`[Satoshi/Anime] Draft written. Word count: ${wordCount}`);

    return {
      title:     item.title,
      pillar:    item.pillar,
      sourceUrl: item.link,
      content:   cleanedText,
      images:    item.images,
      wordCount,
    };
  }

  async rewrite(
    item: ResearchedItem,
    editorFeedback: string,
    newImages?: ArticleImage[]
  ): Promise<DraftArticle> {
    this.log(`[Satoshi/Anime] Rewriting draft with feedback: "${item.title}"`);
    return this.writeDraft({ ...item, images: newImages || item.images }, editorFeedback);
  }
}
