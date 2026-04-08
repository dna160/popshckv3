/**
 * Agent 2: Frame Generator (The Art Director)
 *
 * Responsibilities:
 *   1. Vision Analysis — uses Grok Vision to identify the Contextual Focal Point
 *      of the featured article image (x/y as percentages).
 *   2. Programmatic Execution — passes focal point coordinates + pillar to the
 *      image_processor tool, which crops, overlays the branded frame, and
 *      renders the image_copy text.
 *
 * Returns two rendered Buffers: Post (1:1) and Story (9:16).
 */

import { llmClient } from '../../../services/llm';
import { FOCAL_POINT_SYSTEM_PROMPT } from './prompt';
import { processImage } from './tools/image_processor';

const VISION_MODEL = 'grok-4-fast-non-reasoning';

interface FocalPoint {
  focal_x_pct:  number;
  focal_y_pct:  number;
  description:  string;
}

export class FrameGenerator {
  private log: (msg: string) => void;

  constructor(log: (msg: string) => void = console.log) {
    this.log = log;
  }

  async generate(params: {
    featuredImageUrl: string;
    imageCopy:        string;
    pillar:           string;
    feedback?:        string; // from adversarial editor on retry
  }): Promise<{ postBuffer: Buffer; storyBuffer: Buffer }> {
    const { featuredImageUrl, imageCopy, pillar, feedback } = params;

    this.log(`[FrameGenerator] Analysing focal point for pillar: ${pillar}`);

    // ── Step 1: Grok Vision — identify focal point ────────────────────────────
    const focalPoint = await this.analyseFocalPoint(featuredImageUrl, feedback);
    this.log(
      `[FrameGenerator] Focal point → x:${focalPoint.focal_x_pct.toFixed(2)} ` +
      `y:${focalPoint.focal_y_pct.toFixed(2)} — "${focalPoint.description}"`
    );

    // ── Step 2: Programmatic execution — crop + frame + text ─────────────────
    this.log(`[FrameGenerator] Rendering post and story images…`);
    const { postBuffer, storyBuffer } = await processImage({
      imageUrl:  featuredImageUrl,
      imageCopy,
      pillar,
      focalXPct: focalPoint.focal_x_pct,
      focalYPct: focalPoint.focal_y_pct,
    });

    this.log(`[FrameGenerator] ✓ Post: ${postBuffer.length} bytes, Story: ${storyBuffer.length} bytes`);
    return { postBuffer, storyBuffer };
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private async analyseFocalPoint(imageUrl: string, feedback?: string): Promise<FocalPoint> {
    const userText = feedback
      ? `Analyse this image and return the focal point JSON.\n\nNote from previous review: ${feedback}\nAdjust your focal point recommendation accordingly.`
      : 'Analyse this image and return the focal point JSON.';

    const response = await llmClient.chat.completions.create({
      model: VISION_MODEL,
      messages: [
        { role: 'system', content: FOCAL_POINT_SYSTEM_PROMPT },
        {
          role:    'user',
          content: [
            { type: 'text',      text: userText },
            { type: 'image_url', image_url: { url: imageUrl } },
          ],
        },
      ],
      temperature: 0.2,
    });

    const raw = response.choices[0]?.message?.content ?? '';

    let parsed: FocalPoint;
    try {
      parsed = JSON.parse(raw) as FocalPoint;
    } catch {
      throw new Error(
        `[FrameGenerator] Failed to parse focal point JSON.\nRaw output:\n${raw}`
      );
    }

    // Clamp values to valid range
    parsed.focal_x_pct = Math.max(0, Math.min(1, parsed.focal_x_pct ?? 0.5));
    parsed.focal_y_pct = Math.max(0, Math.min(1, parsed.focal_y_pct ?? 0.4));

    return parsed;
  }
}
