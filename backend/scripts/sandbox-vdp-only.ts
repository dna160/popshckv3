/**
 * sandbox-vdp-only.ts
 *
 * Runs just the Video Digest Pipeline for the anime pillar using the
 * already-published article from the full sandbox run.
 *
 * Run: npx tsx scripts/sandbox-vdp-only.ts [runId]
 * (from backend/ directory)
 */

import dotenv from 'dotenv';
dotenv.config();
process.env.DATABASE_URL = 'file:./prisma/dev.db';

import { PrismaClient }          from '@prisma/client';
import { VideoDigestOrchestrator } from '../src/agents/video_digest/orchestrator';

const TARGET_PILLAR = 'anime' as const;

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function main() {
  const prisma = new PrismaClient();
  const runId  = process.argv[2] || 'cmo2h2yqu0000pf5tzlcef4fp'; // use existing run

  log(`Using runId=${runId}, pillar=${TARGET_PILLAR}`);

  // Check published articles are present
  const articles = await prisma.article.findMany({
    where:   { status: 'PUBLISHED', pillar: TARGET_PILLAR },
    orderBy: { createdAt: 'desc' },
    take:    3,
  });
  log(`Found ${articles.length} published ${TARGET_PILLAR} article(s)`);
  articles.forEach(a => log(`  → [${a.id}] ${a.title}`));

  if (articles.length === 0) {
    log('No published articles — run sandbox-pipeline.ts first');
    process.exit(1);
  }

  // Delete any previous FAILED VideoDigest for this run+pillar so we start fresh
  await prisma.videoDigest.deleteMany({
    where: { runId, pillar: TARGET_PILLAR },
  });
  log('Cleared previous VideoDigest records for this run');

  const vdp = new VideoDigestOrchestrator(prisma);

  log('Starting VDP for anime pillar...');
  const start = Date.now();

  // Call the private runForPillar directly so we only run anime
  // @ts-expect-error — accessing private method for sandbox isolation
  await vdp['runForPillar'](runId, TARGET_PILLAR);

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  log(`VDP done in ${elapsed}s`);

  const digest = await prisma.videoDigest.findFirst({
    where:   { runId, pillar: TARGET_PILLAR },
    orderBy: { createdAt: 'desc' },
  });

  if (digest) {
    log(`VideoDigest status=${digest.status}`);
    if (digest.reelVideoUrl)  log(`  WP video URL: ${digest.reelVideoUrl}`);
    if (digest.igReelId)      log(`  Reel ID:  ${digest.igReelId}`);
    if (digest.igStoryId)     log(`  Story ID: ${digest.igStoryId}`);
    if (digest.voiceoverScript) log(`  Script: ${digest.voiceoverScript.slice(0, 120)}...`);
    if (digest.errorLog)      log(`  Error: ${digest.errorLog}`);
  }

  await prisma.$disconnect();
}

main().catch(err => {
  console.error('FATAL:', err.message);
  console.error(err.stack);
  process.exit(1);
});
