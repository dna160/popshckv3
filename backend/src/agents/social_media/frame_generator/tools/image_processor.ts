/**
 * Image Processor Tool
 *
 * Core image rendering pipeline for social media assets:
 *   1. Fetch source image from URL
 *   2. Smart-crop to Post (1:1 1080×1080) and Story (9:16 1080×1920) using focal point
 *   3. Composite the pillar-specific Popshck branded frame over the crop
 *   4. Render the image_copy text using Quantico Bold via SVG overlay
 *
 * Returns two Buffers ready for upload or review.
 */

import sharp from 'sharp';
import * as fs from 'fs';
import * as path from 'path';

// ── Assets directory ──────────────────────────────────────────────────────────
const ASSETS_DIR = path.resolve(__dirname, '../../assets');

// ── Output dimensions ─────────────────────────────────────────────────────────
const POST_W  = 1080;
const POST_H  = 1080;
const STORY_W = 1080;
const STORY_H = 1920;

// ── Pillar → frame asset filename map ─────────────────────────────────────────
const FRAME_MAP: Record<string, { post: string; story: string }> = {
  anime:        { post: 'Anime Frame Popshck Post.png',          story: 'Anime Frame Popshck Story.png' },
  gaming:       { post: 'Game Frame Popshck Post.png',           story: 'Game Frame Popshck Story.png' },
  infotainment: { post: 'Infotainment Frame Popshck Post.png',   story: 'Infotainment Frame Popshck Story.png' },
  manga:        { post: 'Manga Frame Popshck Post.png',          story: 'Manga Frame Popshck Story.png' },
  toys:         { post: 'Toys Frame Popshck Post.png',           story: 'Toys Frame Popshck Story.png' },
};


// ── XML escaping for SVG text ─────────────────────────────────────────────────
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ── Text overlay builder (native vips_text via sharp — guaranteed Quantico Bold) ─

// Left indent: aligns with the inner edge of the frame corner brackets (~7% from left)
const TEXT_LEFT_INDENT_PCT = 0.07;

// Font file path (absolute) for vips_text fontfile parameter
const FONT_FILE = path.join(ASSETS_DIR, 'Quantico-Bold.ttf');

/**
 * Auto-scale font size so text never overflows the canvas horizontally.
 * Quantico Bold char width ≈ 0.64× the font size in points (at 72 DPI).
 * Left-indented 7%, 5% right margin.
 */
function calcFontSize(text: string, width: number, baseFontSize: number): number {
  const CHAR_WIDTH_RATIO = 0.64;
  const xStart           = Math.round(width * TEXT_LEFT_INDENT_PCT);
  const MAX_TEXT_WIDTH   = width - xStart - Math.round(width * 0.05);
  const estimatedWidth   = text.length * baseFontSize * CHAR_WIDTH_RATIO;
  if (estimatedWidth <= MAX_TEXT_WIDTH) return baseFontSize;
  const scaled = Math.floor(MAX_TEXT_WIDTH / (text.length * CHAR_WIDTH_RATIO));
  return Math.max(scaled, 36);
}

/**
 * Render image_copy text using vips_text (sharp's native Pango/FreeType pipeline).
 * Loads Quantico-Bold.ttf directly via fontfile — no fontconfig, no system install needed.
 *
 * Steps:
 *   1. Render black-on-transparent text at the right font size
 *   2. Negate RGB (black → white), keep alpha — creates white text mask
 *   3. Expand (dilate) a darkened copy for an outline/stroke effect
 *   4. Place shadow offset copy, then stroke copy, then white text on a full-canvas layer
 */
async function buildTextOverlay(
  text:     string,
  width:    number,
  height:   number,
  fontSize: number,
  yPosPct:  number
): Promise<Buffer> {
  const xPos        = Math.round(width * TEXT_LEFT_INDENT_PCT);
  const MAX_TXT_W   = width - xPos - Math.round(width * 0.05); // 5% right margin
  // yPosPct anchors the BOTTOM of the text block (above the logo band)
  const bottomY     = Math.round(height * yPosPct);

  // ── 1. Render text with word-wrap (black on transparent) ──────────────────
  const rawText = await sharp({
    text: {
      text:     escapeXml(text),
      font:     `Quantico Bold ${fontSize}`,
      fontfile: FONT_FILE,
      dpi:      72,
      rgba:     true,
      width:    MAX_TXT_W,   // enables Pango word-wrap at this pixel width
      wrap:     'word',      // wrap on word boundaries
      spacing:  -50,         // ultra tight — lines nearly touching
    },
  }).png().toBuffer();

  const txtMeta  = await sharp(rawText).metadata();
  const txtW     = Math.min(txtMeta.width  ?? MAX_TXT_W, MAX_TXT_W);
  const txtH     = Math.min(txtMeta.height ?? fontSize,  height);

  // Clip rawText to safe bounds in case vips added a pixel or two
  const clippedRaw = await sharp(rawText)
    .resize(txtW, txtH, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  // ── 2. White text: negate RGB only, preserve alpha ────────────────────────
  const whiteText = await sharp(clippedRaw)
    .negate({ alpha: false })   // 0,0,0,A → 255,255,255,A
    .png()
    .toBuffer();

  // ── 3. Black stroke: blur spreads alpha edges outward, clamp to safe size ──
  const strokeText = await sharp(clippedRaw)
    .blur(3)
    .resize(txtW, txtH, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  // ── 4. Anchor text block: bottom of text sits at bottomY ──────────────────
  const topY    = Math.max(0, bottomY - txtH);
  const shadowX = Math.min(xPos + 4, width - txtW);
  const shadowY = Math.max(0, Math.min(height - txtH, topY + 5));

  const overlay = await sharp({
    create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([
      // Shadow (black blurred text, offset)
      { input: strokeText, left: shadowX, top: shadowY,  blend: 'over' },
      // Stroke (black blurred text, at origin for outline)
      { input: strokeText, left: xPos,    top: topY,     blend: 'over' },
      // White text on top
      { input: whiteText,  left: xPos,    top: topY,     blend: 'over' },
    ])
    .png()
    .toBuffer();

  return overlay;
}

// ── Focal-point crop calculator ───────────────────────────────────────────────
function calcCropBox(
  srcW:       number,
  srcH:       number,
  targetW:    number,
  targetH:    number,
  focalXPct:  number,
  focalYPct:  number
): { left: number; top: number; width: number; height: number } {
  // Scale source to fit target dimensions while covering (like background-size: cover)
  const scale  = Math.max(targetW / srcW, targetH / srcH);
  const scaledW = Math.round(srcW * scale);
  const scaledH = Math.round(srcH * scale);

  // Focal point position in scaled image
  const focalX = Math.round(focalXPct * scaledW);
  const focalY = Math.round(focalYPct * scaledH);

  // Crop box centred on focal point, clamped to image bounds
  let left = Math.round(focalX - targetW / 2);
  let top  = Math.round(focalY - targetH / 2);

  left = Math.max(0, Math.min(left, scaledW - targetW));
  top  = Math.max(0, Math.min(top,  scaledH - targetH));

  return { left, top, width: targetW, height: targetH };
}

// ── Frame loader with white-background guard ──────────────────────────────────
/**
 * Load a frame PNG and guarantee it has a proper alpha channel.
 *
 * Some frames are accidentally exported as flat RGB (no transparency).
 * When composited over an article image those frames cover the photo
 * entirely — producing the "white background" bug.
 *
 * If the frame has no alpha channel, this function converts near-white
 * pixels (R>240 && G>240 && B>240) to fully transparent so the article
 * image shows through the empty areas correctly.
 */
async function loadFrameWithTransparency(framePath: string): Promise<Buffer> {
  const meta = await sharp(framePath).metadata();

  // Happy path — frame already has alpha, just return it as-is
  if (meta.hasAlpha) {
    return sharp(framePath).png().toBuffer();
  }

  // Frame has no alpha channel → strip white background programmatically
  const { data, info } = await sharp(framePath)
    .ensureAlpha()   // add opaque alpha channel (all pixels alpha=255)
    .raw()
    .toBuffer({ resolveWithObject: true });

  const buf = Buffer.from(data);

  // Walk every pixel; make near-white pixels transparent
  for (let i = 0; i < buf.length; i += 4) {
    const r = buf[i];
    const g = buf[i + 1];
    const b = buf[i + 2];
    if (r > 240 && g > 240 && b > 240) {
      buf[i + 3] = 0; // transparent
    }
  }

  return sharp(buf, {
    raw: { width: info.width, height: info.height, channels: 4 },
  })
    .png()
    .toBuffer();
}

// ── Main export ───────────────────────────────────────────────────────────────

export interface ProcessImageParams {
  imageUrl:   string;
  imageCopy:  string;
  pillar:     string;
  focalXPct:  number; // 0.0–1.0
  focalYPct:  number; // 0.0–1.0
}

export interface ProcessImageResult {
  postBuffer:  Buffer;
  storyBuffer: Buffer;
}

export async function processImage(params: ProcessImageParams): Promise<ProcessImageResult> {
  const { imageUrl, imageCopy, pillar, focalXPct, focalYPct } = params;

  // ── 1. Fetch source image (with weserv.nl proxy fallback for bot-protected hosts) ─
  const fetchImage = async (url: string): Promise<Buffer> => {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    if (!res.ok) throw new Error(`${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  };

  let srcBuffer: Buffer;
  try {
    srcBuffer = await fetchImage(imageUrl);
  } catch (err: unknown) {
    const status = (err as Error).message;
    if (status === '403' || status === '401' || status === '429') {
      // Bot-protected host — retry via weserv.nl public image proxy
      const stripped = imageUrl.replace(/^https?:\/\//, '');
      const proxyUrl = `https://images.weserv.nl/?url=${encodeURIComponent(stripped)}&output=jpg&q=90`;
      srcBuffer = await fetchImage(proxyUrl).catch(() => {
        throw new Error(`[ImageProcessor] Failed to fetch image (direct: ${status}, proxy also failed): ${imageUrl}`);
      });
    } else {
      throw new Error(`[ImageProcessor] Failed to fetch source image (${status}): ${imageUrl}`);
    }
  }

  // Get source dimensions
  const meta = await sharp(srcBuffer).metadata();
  const srcW = meta.width  ?? 1200;
  const srcH = meta.height ?? 800;

  // ── 2. Resolve frame assets ──────────────────────────────────────────────────
  const frameFiles = FRAME_MAP[pillar] ?? FRAME_MAP['anime'];
  const postFramePath  = path.join(ASSETS_DIR, frameFiles.post);
  const storyFramePath = path.join(ASSETS_DIR, frameFiles.story);

  if (!fs.existsSync(postFramePath) || !fs.existsSync(storyFramePath)) {
    throw new Error(`[ImageProcessor] Frame assets not found for pillar "${pillar}": ${postFramePath}`);
  }

  // ── 3. Build Post (1:1) ──────────────────────────────────────────────────────
  const postBuffer = await renderFormat({
    srcBuffer,
    srcW,
    srcH,
    targetW:    POST_W,
    targetH:    POST_H,
    framePath:  postFramePath,
    imageCopy,
    fontSize:   108,
    textYPosPct: 0.800, // bottom of text block ~15px above full logo zone border
    focalXPct,
    focalYPct,
  });

  // ── 4. Build Story (9:16) ────────────────────────────────────────────────────
  const storyBuffer = await renderFormat({
    srcBuffer,
    srcW,
    srcH,
    targetW:    STORY_W,
    targetH:    STORY_H,
    framePath:  storyFramePath,
    imageCopy,
    fontSize:   128,
    textYPosPct: 0.660, // bottom of text block ~23px above full logo zone border
    focalXPct,
    focalYPct,
  });

  return { postBuffer, storyBuffer };
}

// ── Format renderer (shared logic for post + story) ───────────────────────────
async function renderFormat(params: {
  srcBuffer:   Buffer;
  srcW:        number;
  srcH:        number;
  targetW:     number;
  targetH:     number;
  framePath:   string;
  imageCopy:   string;
  fontSize:    number;
  textYPosPct: number;
  focalXPct:   number;
  focalYPct:   number;
}): Promise<Buffer> {
  const { srcBuffer, srcW, srcH, targetW, targetH, framePath, imageCopy, fontSize, textYPosPct, focalXPct, focalYPct } = params;

  // Scale + crop using focal point
  const scale   = Math.max(targetW / srcW, targetH / srcH);
  const scaledW = Math.round(srcW * scale);
  const scaledH = Math.round(srcH * scale);

  const crop = calcCropBox(srcW, srcH, targetW, targetH, focalXPct, focalYPct);

  const cropped = await sharp(srcBuffer)
    .resize(scaledW, scaledH, { fit: 'fill' })
    .extract({ left: crop.left, top: crop.top, width: crop.width, height: crop.height })
    .png()
    .toBuffer();

  // Resize frame to target dimensions (loadFrameWithTransparency fixes any
  // frame that was exported without an alpha channel — e.g. Infotainment Story)
  const frameBase = await loadFrameWithTransparency(framePath);
  const frame = await sharp(frameBase)
    .resize(targetW, targetH, { fit: 'fill' })
    .png()
    .toBuffer();

  // Build text overlay using native vips_text + Quantico-Bold.ttf
  const textOverlay = await buildTextOverlay(imageCopy, targetW, targetH, fontSize, textYPosPct);

  // Composite: base image → frame overlay → text overlay
  const result = await sharp(cropped)
    .composite([
      { input: frame,       blend: 'over' },
      { input: textOverlay, blend: 'over' },
    ])
    .png()
    .toBuffer();

  return result;
}
