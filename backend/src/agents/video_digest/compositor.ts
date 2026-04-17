import * as fs   from 'fs';
import * as path from 'path';
import * as os   from 'os';
import { runFfmpeg, ffmpegSegmentCmd, ffmpegKenBurnsCmd } from './tools/ffmpeg_utils';
import type {
  Pillar, Storyboard, AudioSegment, VideoSegment, ComposedVideo,
} from './types';

const WATERMARK_PATH = path.resolve('backend/assets/video_digest/brand/watermark.png');

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

        // Grok fallback: empty buffer means static Ken Burns
        if (!isOutro && vSeg.videoBuffer.length === 0) {
          // Download featured image for Ken Burns effect
          const imgPath  = path.join(workDir, `img_${i}.jpg`);
          await downloadImage(seg.imageUrl!, imgPath);

          const args = ffmpegKenBurnsCmd({
            imageIn:     imgPath,
            audioIn,
            out:         segOut,
            durationSec: durSec,
            lowerThird:  seg.lowerThirdText || null,
            watermark:   fs.existsSync(WATERMARK_PATH) ? WATERMARK_PATH : null,
          });
          await runFfmpeg(args);
          continue;
        }

        const videoIn = path.join(workDir, `v_${i}.mp4`);
        const args = ffmpegSegmentCmd({
          videoIn,
          audioIn,
          out:        segOut,
          durationSec: durSec,
          lowerThird: isOutro ? null : (seg.lowerThirdText || null),
          watermark:  isOutro ? null : (fs.existsSync(WATERMARK_PATH) ? WATERMARK_PATH : null),
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
