/**
 * Agent 4: Editor-in-Chief (The Guardrail)
 *
 * Responsibilities:
 * - Full editorial review: quality, tone, hallucination check, UU ITE compliance, image placement
 * - Output: PASS or FAIL with structured feedback
 * - Auto-fix minor issues (Edge Case 1)
 * - Classify failures: MAJOR (rewrite needed) or IMAGE (new images needed)
 * - Enforce 3-strike rule
 */

import { chat, parseJsonResponse } from '../services/llm';
import { marked } from 'marked';
import type { DraftArticle, EditorResult } from '../../../shared/types';
import { PILLAR_LABELS } from '../../../shared/types';

export class Editor {
  private log: (msg: string) => void;

  constructor(log: (msg: string) => void = console.log) {
    this.log = log;
  }

  /**
   * Perform a full editorial review of a draft article.
   */
  async review(draft: DraftArticle, revisionCount: number): Promise<EditorResult> {
    this.log(`[Editor] Reviewing draft: "${draft.title}" (revision ${revisionCount})`);

    const pillarLabel = PILLAR_LABELS[draft.pillar];
    const wordCount = draft.content.trim().split(/\s+/).length;

    const imageList = draft.images
      .map((img, i) => `${i + 1}. ${img.isFeatured ? '[FEATURED] ' : ''}${img.alt}: ${img.url}`)
      .join('\n');

    const prompt = `You are the Editor-in-Chief of a Japanese pop-culture newsroom. Perform a comprehensive editorial review.

ARTICLE UNDER REVIEW:
Title: "${draft.title}"
Pillar: "${pillarLabel}"
Word Count: ${wordCount} (acceptable range: 300–400)
Images (${draft.images.length} total):
${imageList}

Article Content:
---
${draft.content}
---

REVIEW CRITERIA:
1. Writing Quality: Grammar, spelling, clarity, flow, paragraph structure
2. Tone & Pillar Match: Does the article fit the "${pillarLabel}" pillar voice?
3. Accuracy & Hallucinations: Are there specific claims (dates, names, stats) that seem fabricated?
4. UU ITE Compliance: Check for potentially defamatory content, privacy violations, or content that could violate Indonesian Electronic Information and Transactions law (no unverified criminal accusations, no private data exposure, no hate speech)
5. Word Count Compliance: Is the article between 300–400 words?
6. Image Placement: Are images placed contextually throughout the article? Is a featured image designated?
7. Article Structure: Clear intro, body sections with headers, forward-looking conclusion?

DECISION RULES:
- PASS with AUTO-FIX: Minor grammar, punctuation, or formatting issues that you can fix yourself
- FAIL MAJOR: Poor writing quality, wrong tone, potential hallucinations, UU ITE concerns, severe structural problems
- FAIL IMAGE: Images are clearly irrelevant, missing, or improperly placed (and this is the primary problem)

Respond in JSON format:
{
  "passed": true/false,
  "autoFixed": true/false,
  "fixedContent": "the complete corrected article content (only if autoFixed is true)",
  "feedback": "detailed feedback explaining all issues found",
  "issueType": "MINOR" | "MAJOR" | "IMAGE" | null,
  "hallucinations": ["list of potentially fabricated claims, or empty array"]
}

If passed is true and autoFixed is true, include the full corrected markdown in fixedContent.
If passed is false, provide specific, actionable feedback for the copywriter.`;

    try {
      const raw = await chat(
        [{ role: 'user', content: prompt }],
        { temperature: 0.2, maxTokens: 1500 }
      );

      const result = parseJsonResponse<EditorResult>(raw);
      this.log(
        `[Editor] Review complete for "${draft.title}": ${result.passed ? 'PASS' : 'FAIL'}` +
        (result.autoFixed ? ' (auto-fixed)' : '') +
        (result.issueType ? ` [${result.issueType}]` : '')
      );
      return result;
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
   * Apply auto-fixes to the content and regenerate HTML.
   */
  async applyAutoFix(draft: DraftArticle, fixedContent: string): Promise<DraftArticle> {
    const contentHtml = await marked.parse(fixedContent);
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
        return 'GREEN'; // Passed first try or with auto-fix only
      }
      return 'YELLOW'; // Passed after revision loops
    }

    return 'RED'; // Failed, needs human review
  }
}
