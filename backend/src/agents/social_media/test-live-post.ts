/**
 * Social Media Coordinator — Live End-to-End Post Test
 *
 * Fetches a real article from WordPress, runs the full creative pipeline,
 * and publishes the result to Instagram.
 *
 * Usage:
 *   npx tsx src/agents/social_media/test-live-post.ts --url <article-url> [--pillar <name>] [--dry-run] [--skip-vision]
 *
 * Flags:
 *   --url <url>       WordPress article URL (required)
 *   --pillar <name>   anime | gaming | infotainment | manga | toys  (auto-detected if omitted)
 *   --dry-run         Generate images but do NOT post to Instagram
 *   --skip-vision     Use centre focal point instead of Grok Vision (faster)
 */

import * as fs   from 'fs';
import * as path from 'path';
import dotenv    from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

import { HookCopywriter }    from './hook_copywriter/index';
import { FrameGenerator }    from './frame_generator/index';
import { AdversarialEditor } from './adversarial_editor/index';
import { processImage }      from './frame_generator/tools/image_processor';
import { postToInstagram, postStoryToInstagram } from './publisher/tools/social_apis';

// ── CLI args ──────────────────────────────────────────────────────────────────

const args    = process.argv.slice(2);
const getArg  = (flag: string) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : undefined; };
const hasFlag = (flag: string) => args.includes(flag);

const ARTICLE_URL  = getArg('--url');
const PILLAR_HINT  = getArg('--pillar');
const DRY_RUN      = hasFlag('--dry-run');
const SKIP_VISION  = hasFlag('--skip-vision');

if (!ARTICLE_URL) {
  console.error('❌  --url <article-url> is required');
  process.exit(1);
}

const WP_BASE  = process.env['WP_URL']          ?? '';
const WP_USER  = process.env['WP_USERNAME']      ?? '';
const WP_PASS  = process.env['WP_APP_PASSWORD']  ?? '';
const OUTPUT_DIR = path.resolve(__dirname, '../../../test-output');

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

/** Auto-detect content pillar from article text */
function detectPillar(title: string, content: string): string {
  const text = (title + ' ' + content).toLowerCase();
  // Check most-specific first to avoid false positives
  if (/\b(rc car|remote.?control|amphibious|buggy rc|diecast|lego|mainan|gashapon|capsule toy|action figure|model kit|gunpla|nendoroid|scale figure)\b/.test(text)) return 'toys';
  if (/\b(game|gaming|rpg|fps|moba|esports|console|playstation|xbox|nintendo|steam|arknights|genshin|honkai)\b/.test(text)) return 'gaming';
  if (/\b(manga|comic|webtoon|manhwa|chapter)\b/.test(text)) return 'manga';
  if (/\b(anime|cosplay|figure|figurine|seiyuu|voice actor)\b/.test(text)) return 'anime';
  return 'infotainment';
}

/** Strip HTML tags */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#8217;/g, "'")
    .replace(/&#8220;/g, '"')
    .replace(/&#8221;/g, '"')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Upload image buffer — tries WP first, falls back to catbox.moe */
async function uploadImagePublic(buffer: Buffer, filename: string): Promise<string> {
  // Strategy 1: WordPress media library
  try {
    const basicAuth = Buffer.from(`${WP_USER}:${WP_PASS.replace(/\s/g, '')}`).toString('base64');
    const res = await fetch(`${WP_BASE}/wp-json/wp/v2/media`, {
      method:  'POST',
      headers: {
        Authorization:         `Basic ${basicAuth}`,
        'Content-Type':        'image/png',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'User-Agent':          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'X-WP-Nonce':          '',
      },
      body: buffer,
    });
    if (res.ok) {
      const data = await res.json() as { source_url: string };
      log(`  ✓ Uploaded to WordPress: ${data.source_url}`);
      return data.source_url;
    }
    log(`  ⚠  WP upload failed (${res.status}), falling back to catbox.moe…`);
  } catch (err) {
    log(`  ⚠  WP upload error: ${(err as Error).message}, falling back to catbox.moe…`);
  }

  // Strategy 2: catbox.moe — free temp image host, no auth needed
  const form = new FormData();
  form.append('reqtype',      'fileupload');
  form.append('userhash',     '');
  form.append('fileToUpload', new Blob([buffer], { type: 'image/png' }), filename);

  const catboxRes = await fetch('https://catbox.moe/user/api.php', {
    method: 'POST',
    body:   form,
  });
  if (!catboxRes.ok) throw new Error(`catbox.moe upload failed (${catboxRes.status})`);

  const url = (await catboxRes.text()).trim();
  if (!url.startsWith('http')) throw new Error(`catbox.moe returned unexpected response: ${url}`);

  log(`  ✓ Uploaded to catbox.moe: ${url}`);
  return url;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║     Social Media Coordinator — Live Post Test            ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');
  log(`Article URL : ${ARTICLE_URL}`);
  log(`Dry run     : ${DRY_RUN}`);
  log(`Skip vision : ${SKIP_VISION}`);

  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // ── Step 1: Fetch article ──────────────────────────────────────────────────
  separator('STEP 1 — Fetch Article');

  const slug     = slugFromUrl(ARTICLE_URL!);
  const siteDomain = WP_BASE.replace(/^https?:\/\//, '');
  log(`Slug   : ${slug}`);
  log(`Site   : ${siteDomain}`);

  // Strategy: Jina Reader (r.jina.ai) — converts any page to clean markdown,
  // handles Cloudflare-protected sites transparently.
  const jinaUrl = `https://r.jina.ai/${ARTICLE_URL}`;
  log(`Fetching via Jina Reader…`);

  let title   = '';
  let content = '';
  let imageUrl = '';

  const jinaRes = await fetch(jinaUrl, {
    headers: { Accept: 'application/json' }
  });

  if (!jinaRes.ok) throw new Error(`Jina Reader failed (${jinaRes.status})`);

  const jinaData = await jinaRes.json() as {
    data: { title: string; content: string; url: string };
  };

  // Clean the title (strip site name suffix)
  title = jinaData.data.title.replace(/\s*[–—-]\s*POPSHCK?K?.*$/i, '').trim();

  // Extract article body: everything after the breadcrumb / before related posts
  // The article content starts after the first H1 duplicate and featured image
  const rawContent = jinaData.data.content;
  const articleStart = rawContent.indexOf(`# ${title}`);
  const articleBody  = articleStart >= 0 ? rawContent.slice(articleStart) : rawContent;
  // Strip navigation, footer noise (lines with just links/bullets about other articles)
  content = articleBody
    .replace(/!\[Image \d+:[^\]]*\]\([^)]+\)/g, '')   // strip image embeds
    .replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g, '$1') // strip links, keep text
    .replace(/^\s*[*-]\s+.*(anime|toys|game|comic|infotainment|manga).*$/gim, '') // nav items
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  log(`✓ Jina Reader succeeded`);

  // First hostinger upload image = featured image
  const imgMatches = [...rawContent.matchAll(/https?:\/\/hotpink-dogfish[^\s)"]+\.(?:jpg|jpeg|png|webp)/gi)];
  if (imgMatches.length > 0) {
    imageUrl = imgMatches[0][0];
  }

  log(`✓ Title   : ${title}`);
  log(`✓ Content : ${content.slice(0, 120)}…`);
  log(`✓ Image   : ${imageUrl || '(none — will use picsum fallback)'}`);

  // ── Step 2: Resolve image URL ──────────────────────────────────────────────
  separator('STEP 2 — Resolve Featured Image');

  if (!imageUrl) {
    imageUrl = `https://picsum.photos/seed/${slug}/1200/800`;
    log(`⚠  No featured image found — using picsum fallback: ${imageUrl}`);
  } else {
    log(`✓ Featured image: ${imageUrl}`);
  }

  // ── Step 3: Detect pillar ──────────────────────────────────────────────────
  separator('STEP 3 — Detect Content Pillar');  // was STEP 3, still correct

  const pillar = PILLAR_HINT ?? detectPillar(title, content);
  log(`✓ Pillar: ${pillar}`);

  // ── Step 4: Hook Copywriter ────────────────────────────────────────────────
  separator('STEP 4 — Hook Copywriter');

  const articleMarkdown = `# ${title}\n\n${content}`;
  const copywriter = new HookCopywriter(log);
  const copy = await copywriter.generate({ articleMarkdown, pillar });

  log(`✓ image_copy : "${copy.image_copy}"`);
  log(`✓ caption    :\n${copy.caption}`);

  // ── Step 5: Frame Generator ────────────────────────────────────────────────
  separator('STEP 5 — Frame Generator');

  let postBuffer: Buffer;
  let storyBuffer: Buffer;

  if (SKIP_VISION) {
    log('--skip-vision: using centre focal point (0.5, 0.4)');
    const result = await processImage({ imageUrl, imageCopy: copy.image_copy, pillar, focalXPct: 0.5, focalYPct: 0.4 });
    postBuffer  = result.postBuffer;
    storyBuffer = result.storyBuffer;
  } else {
    log('Calling Grok Vision for focal point…');
    const frameGen = new FrameGenerator(log);
    const result = await frameGen.generate({ featuredImageUrl: imageUrl, imageCopy: copy.image_copy, pillar });
    postBuffer  = result.postBuffer;
    storyBuffer = result.storyBuffer;
  }

  log(`✓ Post  : ${(postBuffer.length  / 1024).toFixed(1)} KB`);
  log(`✓ Story : ${(storyBuffer.length / 1024).toFixed(1)} KB`);

  // Save locally
  const ts         = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const postPath   = path.join(OUTPUT_DIR, `live-post-${ts}.png`);
  const storyPath  = path.join(OUTPUT_DIR, `live-story-${ts}.png`);
  fs.writeFileSync(postPath,  postBuffer);
  fs.writeFileSync(storyPath, storyBuffer);
  log(`✓ Post  saved → ${postPath}`);
  log(`✓ Story saved → ${storyPath}`);

  // ── Step 6: Adversarial Editor ─────────────────────────────────────────────
  separator('STEP 6 — Adversarial Editor (QA)');

  const editor  = new AdversarialEditor(log);
  const verdict = await editor.review({
    postImageBuffer:  postBuffer,
    storyImageBuffer: storyBuffer,
    caption:          copy.caption,
    imageCopy:        copy.image_copy,
  });

  log(`✓ Verdict : ${verdict.verdict}`);
  if (verdict.feedback_for_copywriter)     log(`  Copywriter  : ${verdict.feedback_for_copywriter}`);
  if (verdict.feedback_for_frame_generator) log(`  Frame gen   : ${verdict.feedback_for_frame_generator}`);

  if (verdict.verdict !== 'PASS') {
    log('⚠  QA did not pass — images saved locally but skipping Instagram post.');
    log('   Fix issues and re-run to publish.');
    return;
  }

  // ── Step 7: Post to Instagram ──────────────────────────────────────────────
  separator('STEP 7 — Publish to Instagram');

  if (DRY_RUN) {
    log('--dry-run: skipping Instagram publish.');
    log(`  Would post with caption:\n${copy.caption}`);
  } else {
    log('Uploading post image to public host…');
    const publicImageUrl = await uploadImagePublic(postBuffer, `ig-post-${ts}.png`);
    log(`✓ Public image URL: ${publicImageUrl}`);

    log('Creating Instagram post container…');
    const postMediaId = await postToInstagram({
      imageUrl: publicImageUrl,
      caption:  copy.caption,
    });
    log(`✅  Post published! Media ID: ${postMediaId}`);

    log('Uploading story image to public host…');
    const publicStoryUrl = await uploadImagePublic(storyBuffer, `ig-story-${ts}.png`);
    log(`✓ Story image URL: ${publicStoryUrl}`);

    log('Creating Instagram story container…');
    const storyMediaId = await postStoryToInstagram({ imageUrl: publicStoryUrl });
    log(`✅  Story published! Media ID: ${storyMediaId}`);
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  separator('COMPLETE ✅');

  console.log(`  Article   : ${title}`);
  console.log(`  Pillar    : ${pillar}`);
  console.log(`  Post img  : ${postPath}`);
  console.log(`  Story img : ${storyPath}`);
  console.log(`  QA        : ${verdict.verdict}`);
  console.log(`  Instagram : ${DRY_RUN ? 'dry-run (not posted)' : 'POST + STORY POSTED ✅'}`);
  console.log('');
  console.log('  Caption:');
  console.log(copy.caption.split('\n').map(l => `    ${l}`).join('\n'));
  console.log('');
}

main().catch(err => {
  console.error('\n❌ Live post test failed:', err);
  process.exit(1);
});
