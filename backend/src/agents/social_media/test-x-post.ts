/**
 * X (Twitter) — Connection Test + Live Pipeline Post
 *
 * 1. Verifies OAuth 1.0a credentials via GET /2/users/me
 * 2. Fetches a real article via Jina Reader
 * 3. Runs the full creative pipeline (copywriter → frame gen → QA)
 * 4. Uploads the post image via Twitter media upload (v1.1)
 * 5. Posts a tweet with image + caption
 *
 * Usage:
 *   npx tsx src/agents/social_media/test-x-post.ts --url <article-url> [--dry-run] [--skip-vision]
 */

import * as fs     from 'fs';
import * as path   from 'path';
import * as crypto from 'crypto';
import dotenv      from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

import { HookCopywriter }    from './hook_copywriter/index';
import { FrameGenerator }    from './frame_generator/index';
import { AdversarialEditor } from './adversarial_editor/index';
import { processImage }      from './frame_generator/tools/image_processor';

// ── CLI args ──────────────────────────────────────────────────────────────────

const args    = process.argv.slice(2);
const getArg  = (f: string) => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : undefined; };
const hasFlag = (f: string) => args.includes(f);

const ARTICLE_URL = getArg('--url');
const DRY_RUN     = hasFlag('--dry-run');
const SKIP_VISION = hasFlag('--skip-vision');

const OUTPUT_DIR = path.resolve(__dirname, '../../../test-output');

// ── Credentials ───────────────────────────────────────────────────────────────

const API_KEY       = process.env['X_CONSUMER_KEY']        ?? '';
const API_SECRET    = process.env['X_CONSUMER_KEY_SECRET'] ?? '';
const ACCESS_TOKEN  = process.env['X_ACCESS_TOKEN']        ?? '';
const ACCESS_SECRET = process.env['X_ACCESS_SECRET']       ?? '';

// ── Helpers ───────────────────────────────────────────────────────────────────

function log(msg: string): void {
  console.log(`[${new Date().toISOString().slice(11, 23)}] ${msg}`);
}
function separator(label: string): void {
  const line = '─'.repeat(60);
  console.log(`\n${line}\n  ${label}\n${line}\n`);
}
function slugFromUrl(url: string): string {
  return url.replace(/\/$/, '').split('/').pop() ?? '';
}
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#8[0-9]{3};/g, "'")
    .replace(/\s{2,}/g, ' ').trim();
}
function detectPillar(title: string, content: string): string {
  const text = (title + ' ' + content).toLowerCase();
  if (/\b(rc car|remote.?control|amphibious|buggy rc|diecast|lego|mainan|gashapon|capsule toy|action figure|model kit|gunpla|nendoroid|scale figure)\b/.test(text)) return 'toys';
  if (/\b(game|gaming|rpg|fps|moba|esports|console|playstation|xbox|nintendo|steam|arknights|genshin|honkai)\b/.test(text)) return 'gaming';
  if (/\b(manga|comic|webtoon|manhwa|chapter)\b/.test(text)) return 'manga';
  if (/\b(anime|cosplay|figure|figurine|seiyuu|voice actor)\b/.test(text)) return 'anime';
  return 'infotainment';
}

// ── OAuth 1.0a ────────────────────────────────────────────────────────────────

function buildOAuthHeader(
  method: string,
  url: string,
  queryParams: Record<string, string> = {}
): string {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key:     API_KEY,
    oauth_nonce:            crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp:        String(Math.floor(Date.now() / 1000)),
    oauth_token:            ACCESS_TOKEN,
    oauth_version:          '1.0',
  };

  const allParams = { ...queryParams, ...oauthParams };
  const sortedParams = Object.keys(allParams).sort()
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(allParams[k])}`)
    .join('&');

  const base = [method.toUpperCase(), encodeURIComponent(url), encodeURIComponent(sortedParams)].join('&');
  const signingKey = `${encodeURIComponent(API_SECRET)}&${encodeURIComponent(ACCESS_SECRET)}`;
  const signature  = crypto.createHmac('sha1', signingKey).update(base).digest('base64');

  oauthParams['oauth_signature'] = signature;
  const headerValue = Object.keys(oauthParams)
    .map(k => `${encodeURIComponent(k)}="${encodeURIComponent(oauthParams[k])}"`)
    .join(', ');

  return `OAuth ${headerValue}`;
}

// ── X API calls ───────────────────────────────────────────────────────────────

async function getXUser(): Promise<{ id: string; name: string; username: string }> {
  const url    = 'https://api.twitter.com/2/users/me';
  const header = buildOAuthHeader('GET', url);
  const res    = await fetch(url, { headers: { Authorization: header } });
  if (!res.ok) throw new Error(`GET /2/users/me failed (${res.status}): ${await res.text()}`);
  const { data } = await res.json() as { data: { id: string; name: string; username: string } };
  return data;
}

async function uploadXMedia(buffer: Buffer): Promise<string> {
  const url      = 'https://upload.twitter.com/1.1/media/upload.json';
  const b64      = buffer.toString('base64');
  const boundary = `boundary${Date.now()}`;
  const body     = `--${boundary}\r\nContent-Disposition: form-data; name="media_data"\r\n\r\n${b64}\r\n--${boundary}--`;
  const header   = buildOAuthHeader('POST', url);

  const res = await fetch(url, {
    method:  'POST',
    headers: {
      Authorization:  header,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });

  if (!res.ok) throw new Error(`Media upload failed (${res.status}): ${await res.text()}`);
  const { media_id_string } = await res.json() as { media_id_string: string };
  return media_id_string;
}

async function postTweet(text: string, mediaId: string): Promise<string> {
  const url    = 'https://api.twitter.com/2/tweets';
  const header = buildOAuthHeader('POST', url);
  const res    = await fetch(url, {
    method:  'POST',
    headers: { Authorization: header, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ text, media: { media_ids: [mediaId] } }),
  });
  if (!res.ok) throw new Error(`Tweet failed (${res.status}): ${await res.text()}`);
  const { data } = await res.json() as { data: { id: string } };
  return data.id;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║     X (Twitter) — Connection Test + Pipeline Post        ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // ── Step 1: Verify credentials ─────────────────────────────────────────────
  separator('STEP 1 — Verify OAuth Credentials');

  for (const [k, v] of [['X_CONSUMER_KEY', API_KEY], ['X_CONSUMER_KEY_SECRET', API_SECRET], ['X_ACCESS_TOKEN', ACCESS_TOKEN], ['X_ACCESS_SECRET', ACCESS_SECRET]]) {
    if (!v) throw new Error(`Missing env var: ${k}`);
    log(`${k}: ${(v as string).slice(0, 8)}…`);
  }

  const user = await getXUser();
  log(`✓ Token valid — @${user.username} (${user.name}, ID: ${user.id})`);

  if (!ARTICLE_URL) {
    separator('CONNECTION TEST COMPLETE ✅');
    log('Pass --url <article-url> to run the full pipeline and post.');
    return;
  }

  // ── Step 2: Fetch article ──────────────────────────────────────────────────
  separator('STEP 2 — Fetch Article (Jina Reader)');

  log(`URL: ${ARTICLE_URL}`);
  const jinaRes = await fetch(`https://r.jina.ai/${ARTICLE_URL}`, { headers: { Accept: 'application/json' } });
  if (!jinaRes.ok) throw new Error(`Jina Reader failed (${jinaRes.status})`);

  const jinaData = await jinaRes.json() as { data: { title: string; content: string } };
  const title   = jinaData.data.title.replace(/\s*[–—-]\s*POPSHCK?K?.*$/i, '').trim();
  const content = jinaData.data.content
    .replace(/!\[Image \d+:[^\]]*\]\([^)]+\)/g, '')
    .replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g, '$1')
    .replace(/\n{3,}/g, '\n\n').trim();

  const imgMatches = [...jinaData.data.content.matchAll(/https?:\/\/hotpink-dogfish[^\s)"]+\.(?:jpg|jpeg|png|webp)/gi)];
  const imageUrl   = imgMatches[0]?.[0] ?? `https://picsum.photos/seed/${slugFromUrl(ARTICLE_URL)}/1200/800`;

  log(`✓ Title   : ${title}`);
  log(`✓ Image   : ${imageUrl}`);
  log(`✓ Content : ${content.slice(0, 100)}…`);

  // ── Step 3: Detect pillar ──────────────────────────────────────────────────
  separator('STEP 3 — Detect Pillar');

  const pillar = getArg('--pillar') ?? detectPillar(title, content);
  log(`✓ Pillar: ${pillar}`);

  // ── Step 4: Copywriter ─────────────────────────────────────────────────────
  separator('STEP 4 — Hook Copywriter');

  const copy = await new HookCopywriter(log).generate({
    articleMarkdown: `# ${title}\n\n${content}`,
    pillar,
  });
  log(`✓ image_copy : "${copy.image_copy}"`);
  log(`✓ caption    : ${copy.caption}`);

  // ── Step 5: Frame Generator ────────────────────────────────────────────────
  separator('STEP 5 — Frame Generator');

  let postBuffer: Buffer;
  let storyBuffer: Buffer;

  if (SKIP_VISION) {
    log('--skip-vision: centre focal point');
    const r = await processImage({ imageUrl, imageCopy: copy.image_copy, pillar, focalXPct: 0.5, focalYPct: 0.4 });
    postBuffer = r.postBuffer; storyBuffer = r.storyBuffer;
  } else {
    const r = await new FrameGenerator(log).generate({ featuredImageUrl: imageUrl, imageCopy: copy.image_copy, pillar });
    postBuffer = r.postBuffer; storyBuffer = r.storyBuffer;
  }

  const ts       = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const postPath = path.join(OUTPUT_DIR, `x-post-${ts}.png`);
  fs.writeFileSync(postPath, postBuffer);
  log(`✓ Post  : ${(postBuffer.length / 1024).toFixed(1)} KB → ${postPath}`);

  // ── Step 6: QA ─────────────────────────────────────────────────────────────
  separator('STEP 6 — Adversarial Editor (QA)');

  const verdict = await new AdversarialEditor(log).review({
    postImageBuffer: postBuffer, storyImageBuffer: storyBuffer,
    caption: copy.caption, imageCopy: copy.image_copy,
  });
  log(`✓ Verdict: ${verdict.verdict}`);
  if (verdict.feedback_for_frame_generator) log(`  Frame: ${verdict.feedback_for_frame_generator}`);
  if (verdict.feedback_for_copywriter)      log(`  Copy : ${verdict.feedback_for_copywriter}`);

  if (verdict.verdict !== 'PASS') {
    log('⚠  QA did not pass — skipping post.');
    return;
  }

  // ── Step 7: Post to X ──────────────────────────────────────────────────────
  separator('STEP 7 — Post to X (Twitter)');

  if (DRY_RUN) {
    log('--dry-run: skipping post.');
    log(`  Would tweet:\n${copy.caption}`);
    return;
  }

  log('Uploading image to Twitter media endpoint…');
  const mediaId = await uploadXMedia(postBuffer);
  log(`✓ Media ID: ${mediaId}`);

  // Trim caption to fit X's 280-char limit (URL counts as 23 chars)
  const maxCaption = 280 - 23 - 2; // -2 for newline
  const tweetText  = copy.caption.length > maxCaption
    ? copy.caption.slice(0, maxCaption - 1) + '…'
    : copy.caption;

  log('Posting tweet…');
  const tweetId = await postTweet(tweetText + `\n${ARTICLE_URL}`, mediaId);
  log(`✅  Tweet posted! ID: ${tweetId}`);
  log(`    https://x.com/i/web/status/${tweetId}`);

  separator('COMPLETE ✅');
  console.log(`  Article : ${title}`);
  console.log(`  Pillar  : ${pillar}`);
  console.log(`  Tweet   : https://x.com/i/web/status/${tweetId}`);
  console.log(`\n  Caption:\n${copy.caption.split('\n').map(l => `    ${l}`).join('\n')}\n`);
}

main().catch(err => {
  console.error('\n❌ Failed:', err);
  process.exit(1);
});
