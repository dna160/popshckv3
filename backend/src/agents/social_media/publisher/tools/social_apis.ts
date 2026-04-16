/**
 * Social Platform API Integrations
 *
 * Covers: Instagram Graph API, Facebook Graph API, X (Twitter) API v2, TikTok Content Posting API v2.
 *
 * Required environment variables:
 *   IG_ACCESS_TOKEN                — Instagram Graph API token (User or Page token)
 *   INSTAGRAM_BUSINESS_ACCOUNT_ID — IG Business Account ID
 *   FACEBOOK_PAGE_ID               — Facebook Page ID
 *   X_CONSUMER_KEY                 — X (Twitter) API Key (consumer key)
 *   X_CONSUMER_KEY_SECRET          — X (Twitter) API Secret (consumer secret)
 *   X_ACCESS_TOKEN                 — X (Twitter) Access Token
 *   X_ACCESS_SECRET                — X (Twitter) Access Token Secret
 *   TIKTOK_ACCESS_TOKEN            — TikTok Content Posting API access token
 *   TIKTOK_CLIENT_KEY              — TikTok app client key
 *
 * NOTE: API calls are structurally correct but marked TODO where live credentials
 * are needed for final end-to-end testing.
 */

import * as fs   from 'fs';
import * as os   from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

// ── Instagram Graph API (v19.0) ───────────────────────────────────────────────
// Flow: create media container (with public image URL) → publish container

/**
 * Post a 1:1 image to Instagram via Graph API.
 * @param imageUrl  Publicly accessible URL of the post image (e.g. WordPress media URL)
 * @param caption   Full caption text
 * @returns         Instagram media ID
 */
export async function postToInstagram(params: {
  imageUrl: string; // public URL (1:1 post image)
  caption:  string;
}): Promise<string> {
  const token     = requireEnv('IG_ACCESS_TOKEN');
  const accountId = requireEnv('INSTAGRAM_BUSINESS_ACCOUNT_ID');
  const { imageUrl, caption } = params;

  // Step 1: Create media container
  // TODO: test with live credentials
  const containerRes = await fetch(
    `https://graph.facebook.com/v19.0/${accountId}/media`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        image_url:   imageUrl,
        caption,
        access_token: token,
      }),
    }
  );

  if (!containerRes.ok) {
    const err = await containerRes.text();
    throw new Error(`[Instagram] Container creation failed (${containerRes.status}): ${err}`);
  }

  const { id: creationId } = (await containerRes.json()) as { id: string };

  // Step 2: Wait for Instagram to finish processing the image
  // status_code: IN_PROGRESS → FINISHED (usually 5–30 s)
  const MAX_POLLS = 12;
  const POLL_MS   = 5_000;
  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise(r => setTimeout(r, POLL_MS));
    const statusRes = await fetch(
      `https://graph.facebook.com/v19.0/${creationId}?fields=status_code&access_token=${token}`
    );
    if (statusRes.ok) {
      const { status_code } = (await statusRes.json()) as { status_code?: string };
      console.log(`[Instagram] Container status: ${status_code ?? 'unknown'} (poll ${i + 1}/${MAX_POLLS})`);
      if (status_code === 'FINISHED') break;
      if (status_code === 'ERROR' || status_code === 'EXPIRED') {
        throw new Error(`[Instagram] Container processing failed with status: ${status_code}`);
      }
    }
  }

  // Step 3: Publish container
  const publishRes = await fetch(
    `https://graph.facebook.com/v19.0/${accountId}/media_publish`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        creation_id: creationId,
        access_token: token,
      }),
    }
  );

  if (!publishRes.ok) {
    const err = await publishRes.text();
    throw new Error(`[Instagram] Publish failed (${publishRes.status}): ${err}`);
  }

  const { id: mediaId } = (await publishRes.json()) as { id: string };
  return mediaId;
}

/**
 * Post a 9:16 image to Instagram as a Story via Graph API.
 * @param imageUrl  Publicly accessible URL of the story image (9:16)
 * @returns         Instagram media ID
 */
export async function postStoryToInstagram(params: {
  imageUrl: string;
}): Promise<string> {
  const token     = requireEnv('IG_ACCESS_TOKEN');
  const accountId = requireEnv('INSTAGRAM_BUSINESS_ACCOUNT_ID');
  const { imageUrl } = params;

  // Step 1: Create story media container
  const containerRes = await fetch(
    `https://graph.facebook.com/v19.0/${accountId}/media`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        image_url:   imageUrl,
        media_type:  'STORIES',
        access_token: token,
      }),
    }
  );

  if (!containerRes.ok) {
    const err = await containerRes.text();
    throw new Error(`[Instagram Story] Container creation failed (${containerRes.status}): ${err}`);
  }

  const { id: creationId } = (await containerRes.json()) as { id: string };

  // Step 2: Wait for processing
  const MAX_POLLS = 12;
  const POLL_MS   = 5_000;
  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise(r => setTimeout(r, POLL_MS));
    const statusRes = await fetch(
      `https://graph.facebook.com/v19.0/${creationId}?fields=status_code&access_token=${token}`
    );
    if (statusRes.ok) {
      const { status_code } = (await statusRes.json()) as { status_code?: string };
      console.log(`[Instagram Story] Container status: ${status_code ?? 'unknown'} (poll ${i + 1}/${MAX_POLLS})`);
      if (status_code === 'FINISHED') break;
      if (status_code === 'ERROR' || status_code === 'EXPIRED') {
        throw new Error(`[Instagram Story] Container processing failed with status: ${status_code}`);
      }
    }
  }

  // Step 3: Publish story
  const publishRes = await fetch(
    `https://graph.facebook.com/v19.0/${accountId}/media_publish`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        creation_id: creationId,
        access_token: token,
      }),
    }
  );

  if (!publishRes.ok) {
    const err = await publishRes.text();
    throw new Error(`[Instagram Story] Publish failed (${publishRes.status}): ${err}`);
  }

  const { id: mediaId } = (await publishRes.json()) as { id: string };
  return mediaId;
}

// ── Facebook Graph API (v19.0) ────────────────────────────────────────────────

/**
 * Post a 1:1 image to a Facebook Page via Graph API.
 * @param imageUrl  Publicly accessible URL of the post image
 * @param caption   Full caption text
 * @returns         Facebook post ID
 */
export async function postToFacebook(params: {
  imageUrl: string; // public URL (1:1 post image)
  caption:  string;
}): Promise<string> {
  const token  = requireEnv('IG_ACCESS_TOKEN');
  const pageId = requireEnv('FACEBOOK_PAGE_ID');
  const { imageUrl, caption } = params;

  // TODO: test with live credentials
  const res = await fetch(
    `https://graph.facebook.com/v19.0/${pageId}/photos`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        url:          imageUrl,
        message:      caption,
        access_token: token,
      }),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`[Facebook] Photo post failed (${res.status}): ${err}`);
  }

  const { id: postId } = (await res.json()) as { id: string };
  return postId;
}

// ── X (Twitter) API v2 ────────────────────────────────────────────────────────
// Flow: upload media via v1.1 media upload → create tweet with media_id

/**
 * Post an image + caption + article link to X (Twitter).
 * @param imageBuffer  Raw image buffer (post or story)
 * @param caption      Caption text (will be truncated to fit X's char limit)
 * @param articleUrl   Article URL to append to the tweet
 * @returns            Tweet ID
 */
export async function postToX(params: {
  imageBuffer: Buffer;
  caption:     string;
  articleUrl:  string;
}): Promise<string> {
  const apiKey       = requireEnv('X_CONSUMER_KEY');
  const apiSecret    = requireEnv('X_CONSUMER_KEY_SECRET');
  const accessToken  = requireEnv('X_ACCESS_TOKEN');
  const accessSecret = requireEnv('X_ACCESS_SECRET');
  const { imageBuffer, caption, articleUrl } = params;

  // Step 1: Upload media (Twitter API v1.1)
  // TODO: test with live credentials
  const mediaId = await uploadXMedia(imageBuffer, apiKey, apiSecret, accessToken, accessSecret);

  // Step 2: Compose tweet text (X limit: 280 chars; URLs count as 23 chars)
  const urlLength   = 24; // t.co shortened URL
  const maxCaption  = 280 - urlLength - 2; // 2 for newline + space
  const tweetText   = `${caption.slice(0, maxCaption)}\n${articleUrl}`;

  // Step 3: Create tweet (Twitter API v2)
  // TODO: test with live credentials
  const oauthHeader = buildOAuthHeader(
    'POST',
    'https://api.twitter.com/2/tweets',
    {},
    apiKey,
    apiSecret,
    accessToken,
    accessSecret
  );

  const tweetRes = await fetch('https://api.twitter.com/2/tweets', {
    method:  'POST',
    headers: {
      Authorization:  oauthHeader,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      text:  tweetText,
      media: { media_ids: [mediaId] },
    }),
  });

  if (!tweetRes.ok) {
    const err = await tweetRes.text();
    throw new Error(`[X] Tweet creation failed (${tweetRes.status}): ${err}`);
  }

  const { data } = (await tweetRes.json()) as { data: { id: string } };
  return data.id;
}

// ── TikTok Content Posting API v2 ─────────────────────────────────────────────

/**
 * Post a 9:16 video (converted from story image) to TikTok.
 * @param videoBuffer  3-second MP4 buffer
 * @param caption      Caption text
 * @returns            TikTok item_id
 */
export async function postToTikTok(params: {
  videoBuffer: Buffer;
  caption:     string;
}): Promise<string> {
  const accessToken = requireEnv('TIKTOK_ACCESS_TOKEN');
  requireEnv('TIKTOK_CLIENT_KEY'); // validated at startup; used in OAuth flow
  const { videoBuffer, caption } = params;

  // Step 1: Init upload
  // TODO: test with live credentials
  const initRes = await fetch('https://open.tiktokapis.com/v2/post/publish/video/init/', {
    method:  'POST',
    headers: {
      Authorization:  `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
    },
    body: JSON.stringify({
      post_info: {
        title:         caption.slice(0, 150), // TikTok title cap
        privacy_level: 'PUBLIC_TO_EVERYONE',
        disable_duet:  false,
        disable_stitch: false,
        disable_comment: false,
      },
      source_info: {
        source:           'FILE_UPLOAD',
        video_size:       videoBuffer.length,
        chunk_size:       videoBuffer.length,
        total_chunk_count: 1,
      },
    }),
  });

  if (!initRes.ok) {
    const err = await initRes.text();
    throw new Error(`[TikTok] Upload init failed (${initRes.status}): ${err}`);
  }

  const { data: initData } = (await initRes.json()) as {
    data: { publish_id: string; upload_url: string };
  };

  // Step 2: Upload video chunk
  // TODO: test with live credentials
  const uploadRes = await fetch(initData.upload_url, {
    method:  'PUT',
    headers: {
      'Content-Type':          'video/mp4',
      'Content-Range':         `bytes 0-${videoBuffer.length - 1}/${videoBuffer.length}`,
      'Content-Length':        String(videoBuffer.length),
    },
    body: videoBuffer,
  });

  if (!uploadRes.ok) {
    const err = await uploadRes.text();
    throw new Error(`[TikTok] Video upload failed (${uploadRes.status}): ${err}`);
  }

  return initData.publish_id;
}

// ── TikTok: image → 3-second MP4 video ───────────────────────────────────────

/**
 * Convert a still image Buffer to a 3-second silent MP4 using fluent-ffmpeg.
 * Writes to a temp file, reads back, then cleans up.
 */
export async function convertImageToVideo(imageBuffer: Buffer): Promise<Buffer> {
  // Lazy-require so the module only loads when actually needed
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ffmpeg         = require('fluent-ffmpeg') as typeof import('fluent-ffmpeg');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg') as { path: string };
  ffmpeg.setFfmpegPath(ffmpegInstaller.path);

  const tmpDir    = os.tmpdir();
  const inputPath = path.join(tmpDir, `smc-input-${Date.now()}.png`);
  const outputPath = path.join(tmpDir, `smc-output-${Date.now()}.mp4`);

  try {
    fs.writeFileSync(inputPath, imageBuffer);

    await new Promise<void>((resolve, reject) => {
      ffmpeg(inputPath)
        .inputOption('-loop 1')
        .inputOption('-framerate 30')
        .outputOption('-t 3')                     // 3-second duration
        .outputOption('-c:v libx264')
        .outputOption('-pix_fmt yuv420p')          // broadest compatibility
        .outputOption('-vf scale=1080:1920')       // ensure 9:16 dimensions
        .outputOption('-an')                       // no audio
        .outputOption('-movflags +faststart')      // streaming optimisation
        .output(outputPath)
        .on('end',   () => resolve())
        .on('error', (err: Error) => reject(new Error(`[TikTok] ffmpeg error: ${err.message}`)))
        .run();
    });

    return fs.readFileSync(outputPath);
  } finally {
    // Clean up temp files
    for (const p of [inputPath, outputPath]) {
      try { fs.unlinkSync(p); } catch { /* ignore */ }
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`[SocialAPIs] Missing required environment variable: ${name}`);
  return value;
}

/** Upload an image buffer to Twitter's v1.1 media upload endpoint. Returns media_id_string. */
async function uploadXMedia(
  imageBuffer: Buffer,
  apiKey:       string,
  apiSecret:    string,
  accessToken:  string,
  accessSecret: string
): Promise<string> {
  const url = 'https://upload.twitter.com/1.1/media/upload.json';

  // Build multipart form data
  const boundary = `----boundary${Date.now()}`;
  const b64Image = imageBuffer.toString('base64');
  const body = [
    `--${boundary}`,
    'Content-Disposition: form-data; name="media_data"',
    '',
    b64Image,
    `--${boundary}--`,
  ].join('\r\n');

  const oauthHeader = buildOAuthHeader('POST', url, {}, apiKey, apiSecret, accessToken, accessSecret);

  // TODO: test with live credentials
  const res = await fetch(url, {
    method:  'POST',
    headers: {
      Authorization:  oauthHeader,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`[X] Media upload failed (${res.status}): ${err}`);
  }

  const { media_id_string } = (await res.json()) as { media_id_string: string };
  return media_id_string;
}

/**
 * Build an OAuth 1.0a Authorization header for Twitter API calls.
 * Implements HMAC-SHA1 signature per Twitter's spec.
 */
function buildOAuthHeader(
  method:       string,
  url:          string,
  queryParams:  Record<string, string>,
  apiKey:       string,
  apiSecret:    string,
  accessToken:  string,
  accessSecret: string
): string {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key:     apiKey,
    oauth_nonce:            crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp:        String(Math.floor(Date.now() / 1000)),
    oauth_token:            accessToken,
    oauth_version:          '1.0',
  };

  // Collect all params for signature base string
  const allParams: Record<string, string> = { ...queryParams, ...oauthParams };
  const sortedParams = Object.keys(allParams)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(allParams[k])}`)
    .join('&');

  const signatureBase = [
    method.toUpperCase(),
    encodeURIComponent(url),
    encodeURIComponent(sortedParams),
  ].join('&');

  const signingKey = `${encodeURIComponent(apiSecret)}&${encodeURIComponent(accessSecret)}`;
  const signature  = crypto
    .createHmac('sha1', signingKey)
    .update(signatureBase)
    .digest('base64');

  oauthParams['oauth_signature'] = signature;

  const headerValue = Object.keys(oauthParams)
    .map((k) => `${encodeURIComponent(k)}="${encodeURIComponent(oauthParams[k])}"`)
    .join(', ');

  return `OAuth ${headerValue}`;
}
