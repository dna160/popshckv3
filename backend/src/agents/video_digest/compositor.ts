import * as fs   from 'fs';
import * as path from 'path';
import * as os   from 'os';

/** Returns the path only if the file exists AND has non-zero size. */
function validFile(p: string): string | null {
  try {
    return fs.existsSync(p) && fs.statSync(p).size > 0 ? p : null;
  } catch {
    return null;
  }
}
import { runFfmpeg, ffmpegSegmentCmd, ffmpegKenBurnsCmd } from './tools/ffmpeg_utils';
import type {
  Pillar, Storyboard, AudioSegment, VideoSegment, ComposedVideo,
} from './types';

const WATERMARK_PATH = path.resolve('assets/video_digest/brand/watermark.png');

export class Compositor {
  async assemble(
    pillar:    Pillar,
    storyboard: Storyboard,
    audio:     AudioSegment[],
    video:     VideoSegment[]
  ): Promise<ComposedVideo> {
    const workDir = path.join(os.tmpdir(), `vdp-${pillar}-${Date.now()}`);
    fs.mkdirSync(workDir, { recursive: true });

    try {
      // A. Write all buffers to disk
      for (const v of video) {
        if (v.videoBuffer.length > 0) {
          fs.writeFileSync(path.join(workDir, `v_${v.segmentIndex}.mp4`), v.videoBuffer);
        }
      }
      for (const a of audio) {
        fs.writeFileSync(path.join(workDir, `a_${a.segmentIndex}.wav`), a.audioBuffer);
      }

      // B. Per-segment: trim, mix audio, burn overlays → seg_i.mp4
      for (const seg of storyboard.segments) {
        const i       = seg.index;
        const aSeg    = audio.find(x => x.segmentIndex === i)!;
        const vSeg    = video.find(x => x.segmentIndex === i)!;
        const durSec  = aSeg.measuredDurationMs / 1000;
        const isOutro = seg.type === 'outro';
        const segOut  = path.join(workDir, `seg_${i}.mp4`);
        const audioIn = path.join(workDir, `a_${i}.wav`);

        // Outro with empty buffer: generate branded black screen
        if (isOutro && vSeg.videoBuffer.length === 0) {
          console.warn(`[Compositor] Outro brand asset empty — generating placeholder screen`);
          await runFfmpeg([
            '-f',       'lavfi',
            '-i',       `color=c=black:s=1080x1920:d=${durSec}`,
            '-i',       audioIn,
            '-shortest',
            '-c:v',     'libx264',
            '-c:a',     'aac',
            '-y',       segOut,
          ]);
          continue;
        }

        // Grok fallback: empty buffer means static Ken Burns
        if (!isOutro && vSeg.videoBuffer.length === 0) {
          const imgPath = path.join(workDir, `img_${i}.jpg`);
          let imageAvailable = false;
          if (seg.imageUrl) {
            try {
              await downloadImage(seg.imageUrl, imgPath);
              imageAvailable = true;
            } catch {
              console.warn(`[Compositor] Image download failed for segment ${i} — using black screen fallback`);
            }
          }

          if (imageAvailable) {
            const args = ffmpegKenBurnsCmd({
              imageIn:     imgPath,
              audioIn,
              out:         segOut,
              durationSec: durSec,
              lowerThird:  seg.lowerThirdText || null,
              watermark:   validFile(WATERMARK_PATH),
            });
            await runFfmpeg(args);
          } else {
            // Pure black screen with audio — still shows lower-third text
            await runFfmpeg([
              '-f',       'lavfi',
              '-i',       `color=c=0x1a1a2e:s=1080x1920:d=${durSec}`,
              '-i',       audioIn,
              '-shortest',
              '-c:v',     'libx264',
              '-c:a',     'aac',
              '-y',       segOut,
            ]);
          }
          continue;
        }

        const videoIn = path.join(workDir, `v_${i}.mp4`);
        const args = ffmpegSegmentCmd({
          videoIn,
          audioIn,
          out:        segOut,
          durationSec: durSec,
          lowerThird: isOutro ? null : (seg.lowerThirdText || null),
          watermark:  isOutro ? null : (validFile(WATERMARK_PATH)),
        });
        await runFfmpeg(args);
      }

      // C. Concat all segments
      const concatList = storyboard.segments
        .map(s => `file '${path.join(workDir, `seg_${s.index}.mp4`).replace(/'/g, "'\\''")}'`)
        .join('\n');
      const concatFile = path.join(workDir, 'concat.txt');
      fs.writeFileSync(concatFile, concatList);

      const finalPath = path.join(workDir, 'final.mp4');
      await runFfmpeg([
        '-f',    'concat',
        '-safe', '0',
        '-i',    concatFile,
        '-c',    'copy',
        '-y',    finalPath,
      ]);

      const mp4Buffer    = fs.readFileSync(finalPath);
      const totalDurationMs = audio.reduce((sum, a) => sum + a.measuredDurationMs, 0);

      return { pillar, mp4Buffer, caption: storyboard.caption, totalDurationMs };
    } finally {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
}

async function downloadImage(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`[Compositor] Failed to download image ${url}: ${res.status}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}
