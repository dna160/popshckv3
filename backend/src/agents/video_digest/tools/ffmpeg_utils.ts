import { spawn } from 'child_process';

/**
 * Run ffmpeg with the given argument list. Rejects on non-zero exit.
 */
export async function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stderr: string[] = [];

    proc.stderr.on('data', (chunk: Buffer) => stderr.push(chunk.toString()));
    proc.on('error', (err) => reject(new Error(`[FFmpeg] spawn error: ${err.message}`)));
    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`[FFmpeg] exited with code ${code}:\n${stderr.slice(-20).join('')}`));
      }
    });
  });
}

/** Escape text for ffmpeg drawtext filter. */
export function escapeDrawtext(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/'/g,  "\\'")
    .replace(/:/g,  '\\:')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

export interface SegmentCmdOptions {
  videoIn:    string;
  audioIn:    string;
  out:        string;
  durationSec: number;
  lowerThird: string | null;
  watermark:  string | null;
}

/**
 * Build the ffmpeg args for a single segment:
 * - Scale to 1080x1920
 * - Duck native video audio to -20dB, mix with TTS at 0dB
 * - Optionally burn lower-third text and watermark
 * - Trim to exact durationSec
 */
export function ffmpegSegmentCmd(o: SegmentCmdOptions): string[] {
  const args: string[] = ['-i', o.videoIn, '-i', o.audioIn];
  if (o.watermark) args.push('-i', o.watermark);

  // Video filter chain
  let vChain = '[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920[vscaled]';

  if (o.lowerThird) {
    const escaped = escapeDrawtext(o.lowerThird);
    vChain += `;[vscaled]drawtext=text='${escaped}'`;
    vChain += `:fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf`;
    vChain += `:fontsize=48:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=20`;
    vChain += `:x=(w-text_w)/2:y=h-260[vtxt]`;
  }

  const vLabel = o.lowerThird ? 'vtxt' : 'vscaled';
  let vOut     = vLabel;

  if (o.watermark) {
    vChain += `;[${vLabel}][2:v]overlay=W-w-40:40[vwm]`;
    vOut = 'vwm';
  }

  // Audio: duck native to -20dB, mix with TTS (weight 3) at 0dB
  const aChain =
    '[0:a]volume=-20dB[natAud];' +
    '[natAud][1:a]amix=inputs=2:duration=shortest:weights=1 3[aout]';

  args.push(
    '-filter_complex', `${vChain};${aChain}`,
    '-map',   `[${vOut}]`,
    '-map',   '[aout]',
    '-t',     String(o.durationSec),
    '-c:v',   'libx264',
    '-preset', 'fast',
    '-crf',   '23',
    '-c:a',   'aac',
    '-b:a',   '128k',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-y',
    o.out,
  );

  return args;
}

/**
 * Build ffmpeg args for a static Ken Burns fallback segment
 * (used when Grok fails all retries for an article segment).
 */
export function ffmpegKenBurnsCmd(input: {
  imageIn:     string;
  audioIn:     string;
  out:         string;
  durationSec: number;
  lowerThird:  string | null;
  watermark:   string | null;
}): string[] {
  const args: string[] = [
    '-loop', '1', '-i', input.imageIn,
    '-i', input.audioIn,
  ];
  if (input.watermark) args.push('-i', input.watermark);

  const dFrames = Math.ceil(input.durationSec * 25); // 25fps
  let vChain =
    `[0:v]scale=2160:3840,` +
    `zoompan=z='min(zoom+0.0015,1.15)':d=${dFrames}:s=1080x1920:fps=25[vzoomed]`;

  if (input.lowerThird) {
    const escaped = escapeDrawtext(input.lowerThird);
    vChain += `;[vzoomed]drawtext=text='${escaped}'`;
    vChain += `:fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf`;
    vChain += `:fontsize=48:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=20`;
    vChain += `:x=(w-text_w)/2:y=h-260[vtxt]`;
  }

  const vLabel = input.lowerThird ? 'vtxt' : 'vzoomed';
  let vOut     = vLabel;

  if (input.watermark) {
    vChain += `;[${vLabel}][2:v]overlay=W-w-40:40[vwm]`;
    vOut = 'vwm';
  }

  const aChain = '[1:a]volume=0dB[aout]';

  args.push(
    '-filter_complex', `${vChain};${aChain}`,
    '-map',   `[${vOut}]`,
    '-map',   '[aout]',
    '-t',     String(input.durationSec),
    '-c:v',   'libx264',
    '-preset', 'fast',
    '-crf',   '23',
    '-c:a',   'aac',
    '-b:a',   '128k',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-y',
    input.out,
  );

  return args;
}
