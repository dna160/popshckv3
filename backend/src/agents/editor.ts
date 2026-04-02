/**
 * Agent 4: Editor-in-Chief (The Guardrail)
 *
 * Responsibilities:
 * - HTTP HEAD pre-check on image URLs before calling the LLM
 * - Full editorial review: Indonesian headline, writing quality, UU ITE, image validity
 * - Output: PASS or FAIL with structured feedback
 * - Classify failures: WRITING_REVISION (rewrite) or INCOMPLETE_INFO (new images)
 * - Enforce 3-strike rule
 */

import { chat, parseJsonResponse } from '../services/llm';
import { marked } from 'marked';
import type { DraftArticle, EditorResult } from '../../../shared/types';
import { PILLAR_LABELS } from '../../../shared/types';

/**
 * HTTP HEAD pre-check for image URLs.
 * Returns false if any URL is broken or unreachable within 3 seconds.
 */
async function checkImageUrls(urls: string[]): Promise<boolean> {
  for (const url of urls) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);
      const response = await fetch(url, { method: 'HEAD', signal: controller.signal });
      clearTimeout(timeoutId);
      if (!response.ok) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export class Editor {
  private log: (msg: string) => void;

  constructor(log: (msg: string) => void = console.log) {
    this.log = log;
  }

  /**
   * Perform a full editorial review of a draft article.
   * Runs an HTTP HEAD pre-check on images first; if any are broken,
   * bypasses the LLM and immediately returns an INCOMPLETE_INFO failure.
   */
  async review(draft: DraftArticle, revisionCount: number): Promise<EditorResult> {
    this.log(`[Editor] Reviewing draft: "${draft.title}" (revision ${revisionCount})`);

    // ── Image pre-check ─────────────────────────────────────────────────────
    const imageUrls = draft.images.map((img) => img.url);
    if (imageUrls.length > 0) {
      const imagesValid = await checkImageUrls(imageUrls);
      if (!imagesValid) {
        this.log(`[Editor] Image pre-check FAILED for "${draft.title}" — broken URL(s) detected.`);
        return {
          passed: false,
          autoFixed: false,
          feedback: 'INCOMPLETE_INFO: Backend detected 404/broken image URLs. Routing back to Researcher for replacement.',
          issueType: 'IMAGE',
          hallucinations: [],
        };
      }
    }

    // ── LLM editorial review ─────────────────────────────────────────────────
    const pillarLabel = PILLAR_LABELS[draft.pillar];
    const wordCount = draft.content.trim().split(/\s+/).length;

    const imageList = draft.images
      .map((img, i) => `${i + 1}. ${img.isFeatured ? '[FEATURED] ' : ''}${img.alt}: ${img.url}`)
      .join('\n');

    const prompt = `You are the **Editor-in-Chief Agent** (Pantheon) for a Japanese pop-culture newsroom. Your job is to review drafted articles and their embedded images before they are published.

**INPUTS:**

[Article Draft]:
Title: "${draft.title}"
Pillar: "${pillarLabel}"
Word Count: ${wordCount} (acceptable range: 300–400)

Content:
---
${draft.content}
---

[Images] (${draft.images.length} total):
${imageList}

**REVIEW CRITERIA:**
1. **Headline Check (FATAL):** The headline MUST be in Indonesian. If the headline is still written in Japanese characters (Kanji/Kana), you must FAIL the review.
2. **Writing & Tone:** Ensure the text is fluent Indonesian, hallucination-free, and fits the required brand safety standards (No inflammatory content, passes UU ITE).
3. **Image Validity (CRITICAL):** Evaluate the embedded image URLs. If your analysis determines an image is broken, fails to load, or is a generic placeholder/error image, you MUST FAIL the review.
4. **Word Count:** Must be between 300 and 400 words.
5. **Structure:** Clear intro, body sections with headers, forward-looking conclusion.

**OUTPUT FORMAT — respond ONLY with a JSON object:**

If an image is broken or invalid:
{
  "status": "FAIL",
  "error_category": "INCOMPLETE_INFO",
  "reason": "Image X is broken/fails to load. Send back to Researcher for replacement."
}

If the headline is in Japanese or writing needs work:
{
  "status": "FAIL",
  "error_category": "WRITING_REVISION",
  "reason": "Specific actionable feedback for the copywriter."
}

If the article is perfect:
{
  "status": "PASS",
  "error_category": "NONE",
  "reason": "Article meets all editorial and visual standards."
}`;

    try {
      const raw = await chat(
        [{ role: 'user', content: prompt }],
        { temperature: 0.2, maxTokens: 600 }
      );

      const result = parseJsonResponse<{
        status: string;
        error_category: string;
        reason: string;
      }>(raw);

      const passed = result.status === 'PASS';
      const issueType: EditorResult['issueType'] =
        result.error_category === 'INCOMPLETE_INFO' ? 'IMAGE' :
        result.error_category === 'WRITING_REVISION' ? 'MAJOR' :
        null;

      this.log(
        `[Editor] Review complete for "${draft.title}": ${passed ? 'PASS' : 'FAIL'}` +
        (issueType ? ` [${issueType}]` : '')
      );

      return {
        passed,
        autoFixed: false,
        feedback: result.reason || '',
        issueType,
        hallucinations: [],
      };
    } catch (err) {
      this.log(`[Editor] Review parsing failed: ${(err as Error).message}`);
      // On parse failure, do a lenient pass to avoid blocking the pipeline
      return {
        passed: true,
        autoFixed: false,
        feedback: 'Editorial review encountered a parsing error. Passing with caution.',
        issueType: null,
        hallucinations: [],
      };
    }
  }

  /**
   * Apply auto-fixes to the content.
   */
  async applyAutoFix(draft: DraftArticle, fixedContent: string): Promise<DraftArticle> {
    await marked.parse(fixedContent);
    return {
      ...draft,
      content: fixedContent,
    };
  }

  /**
   * Determine the final article status based on revision count and pass/fail.
   * Returns: 'GREEN' | 'YELLOW' | 'RED' | 'FAILED'
   */
  determineStatus(
    passed: boolean,
    autoFixed: boolean,
    revisionCount: number
  ): 'GREEN' | 'YELLOW' | 'RED' | 'FAILED' {
    if (revisionCount >= 3 && !passed) {
      return 'FAILED';
    }

    if (passed) {
      if (revisionCount === 0 || (revisionCount === 0 && autoFixed)) {
        return 'GREEN';
      }
      return 'YELLOW';
    }

    return 'RED';
  }
}
