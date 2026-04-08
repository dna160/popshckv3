/**
 * Agent 3: Adversarial Editor (Quality Assurance)
 *
 * Acts as a ruthless Social Media Manager. Reviews the final composed images
 * (Post + Story with frame and text overlay) and the caption using Grok Vision.
 *
 * Evaluation criteria:
 *   1. Legibility  — is the image_copy text readable on the image?
 *   2. Framing     — is the crop well-composed? No decapitated subjects?
 *   3. Brand Safety — is the Popshck frame visible and correct?
 *   4. Copy QA     — is the caption well-formed, in Indonesian, with hashtags?
 *
 * On FAIL: returns targeted feedback for the copywriter and/or frame generator.
 * On PASS: hands off to the Publisher.
 */

import sharp from 'sharp';
import { llmClient } from '../../../services/llm';
import { ADVERSARIAL_EDITOR_SYSTEM_PROMPT } from './prompt';

const VISION_MODEL = 'grok-4-fast-non-reasoning';

/** Resize a PNG buffer to a smaller JPEG for vision-model review. */
async function resizeForReview(buffer: Buffer, width: number, height: number): Promise<Buffer> {
  return sharp(buffer)
    .resize(width, height, { fit: 'fill' })
    .jpeg({ quality: 85 })
    .toBuffer();
}

export interface EditorVerdict {
  verdict:                     'PASS' | 'FAIL';
  feedback_for_copywriter:     string | null;
  feedback_for_frame_generator: string | null;
}

export class AdversarialEditor {
  private log: (msg: string) => void;

  constructor(log: (msg: string) => void = console.log) {
    this.log = log;
  }

  async review(params: {
    postImageBuffer:  Buffer;
    storyImageBuffer: Buffer;
    caption:          string;
    imageCopy:        string;
  }): Promise<EditorVerdict> {
    const { postImageBuffer, storyImageBuffer, caption, imageCopy } = params;

    this.log('[AdversarialEditor] Reviewing rendered images and caption…');

    // Downsample to 540px wide before encoding — reduces base64 payload ~4×
    // and prevents the vision model from hallucinating artifacts in compressed data.
    const postSmall  = await resizeForReview(postImageBuffer,  540,  540);
    const storySmall = await resizeForReview(storyImageBuffer, 540,  960);
    const postDataUrl  = `data:image/jpeg;base64,${postSmall.toString('base64')}`;
    const storyDataUrl = `data:image/jpeg;base64,${storySmall.toString('base64')}`;

    const response = await llmClient.chat.completions.create({
      model: VISION_MODEL,
      messages: [
        { role: 'system', content: ADVERSARIAL_EDITOR_SYSTEM_PROMPT },
        {
          role:    'user',
          content: [
            {
              type: 'text',
              text: [
                `Image Copy Text (should appear on both images): "${imageCopy}"`,
                '',
                `Caption:`,
                caption,
                '',
                'Review both images below and return your verdict JSON.',
              ].join('\n'),
            },
            {
              type:      'image_url',
              image_url: { url: postDataUrl },
            },
            {
              type:      'image_url',
              image_url: { url: storyDataUrl },
            },
          ],
        },
      ],
      temperature: 0.3,
    });

    const raw = response.choices[0]?.message?.content ?? '';

    let parsed: EditorVerdict;
    try {
      parsed = JSON.parse(raw) as EditorVerdict;
    } catch {
      // If the editor fails to return valid JSON, treat as a soft pass
      // (we cannot let a broken editor block publication indefinitely)
      this.log(`[AdversarialEditor] ⚠ Could not parse verdict JSON — defaulting to PASS. Raw: ${raw}`);
      return {
        verdict:                      'PASS',
        feedback_for_copywriter:      null,
        feedback_for_frame_generator: null,
      };
    }

    if (parsed.verdict !== 'PASS' && parsed.verdict !== 'FAIL') {
      this.log(`[AdversarialEditor] ⚠ Unexpected verdict value "${parsed.verdict}" — defaulting to PASS`);
      parsed.verdict = 'PASS';
    }

    this.log(
      `[AdversarialEditor] Verdict: ${parsed.verdict}` +
      (parsed.feedback_for_copywriter      ? ` | Copywriter: ${parsed.feedback_for_copywriter}`      : '') +
      (parsed.feedback_for_frame_generator ? ` | FrameGen: ${parsed.feedback_for_frame_generator}` : '')
    );

    return parsed;
  }
}
