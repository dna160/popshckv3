/**
 * sandbox-pipeline.ts
 *
 * End-to-end pipeline sandbox test.
 * Runs the full pipeline organically for 1 article on the anime pillar:
 *   Scout → Researcher → AnimeSatoshi (Copywriter) → Editor → Publisher → VDP
 *
 * Run: npx tsx scripts/sandbox-pipeline.ts
 * (from backend/ directory)
 */

import dotenv from 'dotenv';
dotenv.config();
// Force SQLite for local sandbox (production uses Railway internal PostgreSQL)
process.env.DATABASE_URL = 'file:./prisma/dev.db';

import { PrismaClient } from '@prisma/client';
import { marked }       from 'marked';

import { Scout }          from '../src/agents/scout';
import { Researcher }     from '../src/agents/researcher';
import { AnimeSatoshi }   from '../src/agents/copywriters/anime_satoshi/index';
import { Editor }         from '../src/agents/editor';
import { Publisher }      from '../src/agents/publisher/index';
import { VideoDigestOrchestrator } from '../src/agents/video_digest/orchestrator';
import { updateArticleState }      from '../src/orchestrator/tools/update_ui';

// ── Config ────────────────────────────────────────────────────────────────────

const TARGET_PILLAR   = 'anime' as const;
const MAX_REVISIONS   = 3;

// ── Logging ───────────────────────────────────────────────────────────────────

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function section(title: string) {
  const line = '─'.repeat(60);
  console.log(`\n${line}\n  ${title}\n${line}`);
}

function elapsed(start: number) {
  return `${((Date.now() - start) / 1000).toFixed(1)}s`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractH1(markdown: string): string | null {
  const m = markdown.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : null;
}

function stripJudul(markdown: string): string {
  return markdown.replace(/^\*\*Judul:\*\*\s*.+\n?/m, '');
}

function stripH1(markdown: string): string {
  return markdown.replace(/^#\s+.+\n?/m, '');
}

function extractJudul(markdown: string): string | null {
  const m = markdown.match(/^\*\*Judul:\*\*\s*(.+)$/m);
  return m ? m[1].trim() : null;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const runStart = Date.now();
  const prisma   = new PrismaClient();

  log('Sandbox pipeline starting — TARGET: 1 anime article → VDP');

  // Create a PipelineRun record (VDP needs this for its VideoDigest relation)
  const pipelineRun = await prisma.pipelineRun.create({
    data: { status: 'RUNNING' },
  });
  const runId = pipelineRun.id;
  log(`PipelineRun created: ${runId}`);

  let articleId: string | null = null;

  try {

    // ══════════════════════════════════════════════════════════════════════════
    section('PHASE 1 — SCOUT');
    // ══════════════════════════════════════════════════════════════════════════

    const t1     = Date.now();
    const scout  = new Scout(prisma, (msg) => log(`  [Scout] ${msg}`));
    const items  = await scout.run({ mode: 'round_1' });

    const animeItems = items.filter(i => i.pillar === TARGET_PILLAR);
    log(`Scout: ${items.length} total items, ${animeItems.length} anime (${elapsed(t1)})`);

    if (animeItems.length === 0) {
      // Fall back to underquota protocol targeting anime specifically
      log('No anime items from round_1 — running underquota protocol for anime...');
      const underquota = await scout.run(
        { mode: 'underquota_protocol', missing_pillars: [TARGET_PILLAR] },
        new Set()
      );
      animeItems.push(...underquota.filter(i => i.pillar === TARGET_PILLAR));
    }

    if (animeItems.length === 0) {
      throw new Error('Scout returned 0 anime candidates even after underquota protocol — cannot continue');
    }

    const topic = animeItems[0];
    log(`Selected: "${topic.title}"`);
    log(`Source:   ${topic.link}`);

    // ══════════════════════════════════════════════════════════════════════════
    section('PHASE 2 — RESEARCHER');
    // ══════════════════════════════════════════════════════════════════════════

    const t2         = Date.now();
    const researcher = new Researcher((msg) => log(`  [Researcher] ${msg}`));
    const researched = await researcher.researchItem(topic);

    log(`Researcher: approved=${researched.approved} images=${researched.images.length} facts=${researched.facts.length} (${elapsed(t2)})`);

    if (!researched.approved) {
      throw new Error(`Researcher rejected "${topic.title}": ${researched.rejectionReason}`);
    }

    // Create Article DB record
    const article = await prisma.article.create({
      data: {
        title:     topic.title,
        pillar:    topic.pillar,
        sourceUrl: topic.link,
        status:    'PROCESSING',
      },
    });
    articleId = article.id;
    log(`Article record created: ${articleId}`);

    // ══════════════════════════════════════════════════════════════════════════
    section('PHASE 3 — COPYWRITER (AnimeSatoshi) + EDITOR');
    // ══════════════════════════════════════════════════════════════════════════

    const t3         = Date.now();
    const copywriter = new AnimeSatoshi((msg) => log(`  [Satoshi] ${msg}`));
    const editor     = new Editor((msg) => log(`  [Editor] ${msg}`));

    let draft         = null as Awaited<ReturnType<AnimeSatoshi['writeDraft']>> | null;
    let revisionCount = 0;
    let lastFeedback  = '';
    let currentImages = researched.images;
    let finalStatus:  string | null = null;
    let finalContent: string | null = null;
    let finalHtml:    string | null = null;
    let finalTitle:   string | null = null;

    for (let attempt = 0; attempt < MAX_REVISIONS; attempt++) {
      log(`  Copywriter attempt ${attempt + 1}/${MAX_REVISIONS}...`);

      draft = draft === null
        ? await copywriter.writeDraft({ ...researched, images: currentImages })
        : await copywriter.rewrite({ ...researched, images: currentImages }, lastFeedback, currentImages);

      // Routing signal: broken images
      if (draft.content.trim().startsWith('SYSTEM_ROUTE_TO_RESEARCHER')) {
        log('  Copywriter flagged broken images — re-dispatching Researcher');
        const existingUrls = new Set(currentImages.map(img => img.url));
        const newImages    = await researcher.findImages(topic.title, topic.pillar, existingUrls);
        if (newImages.length > 0) {
          currentImages = newImages;
          log(`  Researcher returned ${newImages.length} replacement images`);
        } else {
          log('  Researcher found no replacement images — continuing with existing');
        }
        revisionCount++;
        draft = null;
        continue;
      }

      // Extract Indonesian title
      const judul = extractJudul(draft.content);
      const h1    = extractH1(draft.content);
      if (judul || h1) finalTitle = judul ?? h1;

      // Editor review
      const t3e    = Date.now();
      const verdict = await editor.review(draft, revisionCount);
      log(`  Editor (attempt ${attempt + 1}): passed=${verdict.passed} type=${verdict.issueType ?? 'n/a'} (${elapsed(t3e)})`);

      if (verdict.passed) {
        let body = stripJudul(draft.content);
        if (verdict.autoFixed && verdict.fixedContent) {
          body = stripH1(stripJudul(verdict.fixedContent));
        } else {
          body = stripH1(body);
        }
        finalContent = body;
        finalHtml    = await marked.parse(body);
        finalStatus  = editor.determineStatus(true, verdict.autoFixed, revisionCount);
        log(`  Editor PASS → status=${finalStatus}`);
        break;
      }

      // Editor FAIL
      lastFeedback = verdict.feedback;
      revisionCount++;

      if (verdict.issueType === 'UNSALVAGEABLE') {
        log('  Editor: UNSALVAGEABLE — aborting');
        break;
      }

      if (verdict.issueType === 'IMAGE') {
        log('  Editor: IMAGE failure — re-fetching images');
        const existingUrls = new Set(currentImages.map(img => img.url));
        const newImages    = await researcher.findImages(topic.title, topic.pillar, existingUrls);
        if (newImages.length > 0) currentImages = newImages;
        draft = null; // force full rewrite with new images
      }
    }

    if (!finalStatus || !finalContent) {
      log(`Copywriter/Editor loop failed after ${MAX_REVISIONS} attempts → marking RED`);
      await updateArticleState(prisma, articleId, { status: 'RED', revisionCount });
      throw new Error('Article failed all revision rounds');
    }

    await updateArticleState(prisma, articleId, {
      status:       finalStatus,
      title:        finalTitle ?? topic.title,
      content:      finalContent,
      contentHtml:  finalHtml!,
      images:       JSON.stringify(currentImages),
      revisionCount,
    });
    log(`Copywriter+Editor done: status=${finalStatus} (${elapsed(t3)})`);

    // ══════════════════════════════════════════════════════════════════════════
    section('PHASE 4 — PUBLISHER (WordPress)');
    // ══════════════════════════════════════════════════════════════════════════

    const t4 = Date.now();

    if (finalStatus !== 'GREEN' && finalStatus !== 'YELLOW') {
      log(`Status is ${finalStatus} — skipping WordPress publish`);
    } else if (!process.env.WP_URL && !process.env.WP_BASE_URL) {
      log('No WP_URL configured — skipping WordPress publish');
    } else {
      const publisher = new Publisher((msg) => log(`  [Publisher] ${msg}`));
      const { wpPostId, wpPostUrl } = await publisher.publish({
        title:       finalTitle ?? topic.title,
        contentHtml: finalHtml!,
        images:      currentImages,
        pillar:      topic.pillar,
        authorName:  copywriter.personaName,
      });
      await updateArticleState(prisma, articleId, {
        status:    'PUBLISHED',
        wpPostId,
        wpPostUrl,
      });
      log(`Published → WP Post #${wpPostId}: ${wpPostUrl} (${elapsed(t4)})`);
    }

    // ══════════════════════════════════════════════════════════════════════════
    section('PHASE 5 — VIDEO DIGEST PIPELINE');
    // ══════════════════════════════════════════════════════════════════════════

    const t5 = Date.now();

    // Mark run as completed so VDP can reference its PipelineRun relation
    await prisma.pipelineRun.update({
      where: { id: runId },
      data:  { status: 'COMPLETED', articlesProcessed: 1, completedAt: new Date() },
    });

    // VDP runs one pillar — anime only in this sandbox
    // We instantiate it directly and await (not fire-and-forget) so we see all output
    const vdp = new VideoDigestOrchestrator(prisma);

    // Run only the anime pillar for the sandbox
    // @ts-expect-error — calling the private runForPillar directly for sandbox isolation
    await vdp['runForPillar'](runId, TARGET_PILLAR);

    log(`VDP done (${elapsed(t5)})`);

    // ══════════════════════════════════════════════════════════════════════════
    section('SANDBOX COMPLETE');
    // ══════════════════════════════════════════════════════════════════════════

    log(`Total elapsed: ${elapsed(runStart)}`);

    // Print VideoDigest record
    const digest = await prisma.videoDigest.findFirst({
      where:   { runId, pillar: TARGET_PILLAR },
      orderBy: { createdAt: 'desc' },
    });

    if (digest) {
      log(`VideoDigest: status=${digest.status}`);
      if (digest.igReelId)  log(`  Reel ID:  ${digest.igReelId}`);
      if (digest.igStoryId) log(`  Story ID: ${digest.igStoryId}`);
      if (digest.errorLog)  log(`  Error: ${digest.errorLog}`);
    }

  } catch (err) {
    section('SANDBOX FAILED');
    log(`Error: ${(err as Error).message}`);
    console.error((err as Error).stack);

    await prisma.pipelineRun.update({
      where: { id: runId },
      data:  { status: 'FAILED', completedAt: new Date() },
    }).catch(() => {/* ignore */});

    process.exit(1);

  } finally {
    await prisma.$disconnect();
  }
}

main();
