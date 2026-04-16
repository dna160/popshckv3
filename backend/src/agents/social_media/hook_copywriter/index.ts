/**
 * Agent 1: Hook Copywriter
 *
 * Receives a published article and its content pillar.
 * Produces:
 *   - image_copy: 5-6 word punchy hook for rendering on the image
 *   - caption: full Indonesian social media caption with emojis and hashtags
 *
 * On adversarial editor FAIL, accepts targeted feedback and regenerates.
 */

import { llmClient, MODEL } from '../../../services/llm';
import { HOOK_COPYWRITER_SYSTEM_PROMPT } from './prompt';

export interface HookCopywriterOutput {
  image_copy: string;
  caption:    string;
}

export class HookCopywriter {
  private log: (msg: string) => void;

  constructor(log: (msg: string) => void = console.log) {
    this.log = log;
  }

  async generate(params: {
    articleMarkdown: string;
    pillar:          string;
    feedback?:       string; // from adversarial editor on retry
  }): Promise<HookCopywriterOutput> {
    const { articleMarkdown, pillar, feedback } = params;

    this.log(`[HookCopywriter] Generating copy for pillar: ${pillar}${feedback ? ' (with feedback)' : ''}`);

    const userMessage = [
      `Content Pillar: ${pillar}`,
      '',
      '## Article',
      articleMarkdown,
      ...(feedback ? ['', '## Editor Feedback (address these issues in your revised output)', feedback] : []),
    ].join('\n');

    const response = await llmClient.chat.completions.create({
      model:    MODEL,
      messages: [
        { role: 'system', content: HOOK_COPYWRITER_SYSTEM_PROMPT },
        { role: 'user',   content: userMessage },
      ],
      temperature: 0.8,
    });

    const raw = response.choices[0]?.message?.content ?? '';

    let parsed: HookCopywriterOutput;
    try {
      parsed = JSON.parse(raw) as HookCopywriterOutput;
    } catch {
      throw new Error(
        `[HookCopywriter] Failed to parse JSON response.\nRaw output:\n${raw}`
      );
    }

    if (!parsed.image_copy || !parsed.caption) {
      throw new Error(
        `[HookCopywriter] Response missing required fields (image_copy, caption).\nParsed: ${JSON.stringify(parsed)}`
      );
    }

    this.log(`[HookCopywriter] ✓ image_copy: "${parsed.image_copy}"`);
    return parsed;
  }
}
