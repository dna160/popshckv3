import * as fs   from 'fs';
import * as path from 'path';
import { generateVideo } from './tools/grok_client';
import type { Storyboard, AudioSegment, VideoSegment } from './types';

const MAX_RETRIES        = 2;
const RETRY_DELAYS_MS    = [5_000, 15_000];
const BRAND_ASSETS_DIR   = path.resolve('backend/assets/video_digest/brand');
const GROK_MIN_SEC       = 5;
const GROK_MAX_SEC       = 10;

async function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function generateWithRetry(params: Parameters<typeof generateVideo>[0]): Promise<Buffer> {
  let lastErr: Error = new Error('No attempts made');
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await generateVideo(params);
    } catch (err) {
      lastErr = err as Error;
      if (attempt < MAX_RETRIES) {
        console.warn(`[VideoGenerator] Grok attempt ${attempt + 1} failed, retrying in ${RETRY_DELAYS_MS[attempt]}ms: ${lastErr.message}`);
        await sleep(RETRY_DELAYS_MS[attempt]);
      }
    }
  }
  throw lastErr;
}

export class VideoGenerator {
  async generate(
    storyboard: Storyboard,
    audio:      AudioSegment[]
  ): Promise<VideoSegment[]> {
    const results = await Promise.all(
      storyboard.segments.map(async (seg): Promise<VideoSegment> => {
        // Outro: load pre-rendered brand asset — no Grok call
        if (seg.type === 'outro') {
          const assetPath = path.join(BRAND_ASSETS_DIR, `outro_${storyboard.pillar}.mp4`);
          if (!fs.existsSync(assetPath)) {
            throw new Error(`[VideoGenerator] Brand outro missing: ${assetPath}`);
          }
          return {
            segmentIndex:    seg.index,
            videoBuffer:     fs.readFileSync(assetPath),
            actualDurationMs: 2000,
            source:          'brand_outro',
          };
        }

        // Article segment — duration driven by measured audio
        const audioSeg = audio.find(a => a.segmentIndex === seg.index);
        if (!audioSeg) throw new Error(`[VideoGenerator] Missing audio for segment ${seg.index}`);

        const requestedSec = Math.min(
          GROK_MAX_SEC,
          Math.max(GROK_MIN_SEC, Math.ceil(audioSeg.measuredDurationMs / 1000))
        );

        console.log(`[VideoGenerator] Segment ${seg.index}: Grok I2V duration=${requestedSec}s`);

        let videoBuffer: Buffer;
        try {
          videoBuffer = await generateWithRetry({
            imageUrl:    seg.imageUrl!,
            prompt:      seg.grokPrompt,
            durationSec: requestedSec,
            aspectRatio: '9:16',
            resolution:  '720p',
          });
        } catch (err) {
          // Fallback flag: compositor will synthesize a Ken Burns static segment
          console.error(`[VideoGenerator] Segment ${seg.index} Grok failed after retries, using static fallback: ${(err as Error).message}`);
          // Return empty buffer with special source marker handled by compositor
          videoBuffer = Buffer.alloc(0);
          return {
            segmentIndex:    seg.index,
            videoBuffer,
            actualDurationMs: requestedSec * 1000,
            source:          'grok',  // compositor checks empty buffer
          };
        }

        return {
          segmentIndex:    seg.index,
          videoBuffer,
          actualDurationMs: requestedSec * 1000,
          source:          'grok',
        };
      })
    );

    return results.sort((a, b) => a.segmentIndex - b.segmentIndex);
  }
}
