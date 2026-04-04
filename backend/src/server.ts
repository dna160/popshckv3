/**
 * Express API Server
 *
 * Provides REST API endpoints for the frontend dashboard.
 * Also starts the continuous pipeline cron worker.
 */

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import cron from 'node-cron';
import path from 'path';
import fs from 'fs';
import { PrismaClient } from '@prisma/client';
import { marked } from 'marked';
import dotenv from 'dotenv';
import { runPipeline, isPipelineRunning, abortPipeline } from './continuous-pipeline';
import { publishArticle } from './services/wordpress';
import type { ArticleImage, ApiResponse, Pillar } from './shared/types';

dotenv.config();

const app = express();
const prisma = new PrismaClient();
const PORT = Number(process.env.PORT) || 3001;

// Middleware
app.use(cors({ origin: '*', methods: ['GET','POST','PATCH','DELETE','OPTIONS'] }));
app.use(express.json());

// ============================================================
// Helper: Parse article images from DB JSON string
// ============================================================
function parseImages(raw: string | null): ArticleImage[] {
  if (!raw) return [];
  try {
    return JSON.parse(raw) as ArticleImage[];
  } catch {
    return [];
  }
}

// ============================================================
// Helper: Parse pipeline logs
// ============================================================
function parseLogs(raw: string | null) {
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

// ============================================================
// Article Routes
// ============================================================

/**
 * GET /api/articles
 * List all articles with status (no full content for performance)
 */
app.get('/api/articles', async (_req: Request, res: Response) => {
  try {
    const articles = await prisma.article.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        title: true,
        pillar: true,
        sourceUrl: true,
        status: true,
        revisionCount: true,
        editorNotes: true,
        wpPostId: true,
        wpPostUrl: true,
        createdAt: true,
        updatedAt: true,
        images: true,
      },
    });

    const mapped = articles.map((a) => ({
      ...a,
      images: parseImages(a.images),
    }));

    res.json({ success: true, data: mapped } satisfies ApiResponse<typeof mapped>);
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/**
 * GET /api/articles/:id
 * Get a single article with full content
 */
app.get('/api/articles/:id', async (req: Request, res: Response) => {
  try {
    const article = await prisma.article.findUnique({
      where: { id: req.params.id },
    });

    if (!article) {
      return res.status(404).json({ success: false, error: 'Article not found' });
    }

    res.json({
      success: true,
      data: { ...article, images: parseImages(article.images) },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/**
 * POST /api/articles/:id/publish
 * Manually publish a YELLOW or RED article to WordPress
 */
app.post('/api/articles/:id/publish', async (req: Request, res: Response) => {
  try {
    const article = await prisma.article.findUnique({
      where: { id: req.params.id },
    });

    if (!article) {
      return res.status(404).json({ success: false, error: 'Article not found' });
    }

    if (!['YELLOW', 'RED', 'GREEN'].includes(article.status)) {
      return res.status(400).json({
        success: false,
        error: `Article status "${article.status}" is not publishable`,
      });
    }

    if (!article.contentHtml && !article.content) {
      return res.status(400).json({ success: false, error: 'Article has no content to publish' });
    }

    const contentHtml = article.contentHtml || (await marked.parse(article.content || ''));
    const images = parseImages(article.images);

    if (!process.env.WP_BASE_URL && !process.env.WP_URL) {
      return res.status(503).json({
        success: false,
        error: 'WordPress is not configured on this server',
      });
    }

    const { wpPostId, wpPostUrl } = await publishArticle(article.title, contentHtml, images, article.pillar as Pillar);

    await prisma.article.update({
      where: { id: article.id },
      data: { status: 'PUBLISHED', wpPostId, wpPostUrl },
    });

    res.json({ success: true, data: { wpPostId, wpPostUrl } });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/**
 * PATCH /api/articles/:id
 * Update article content (used by human reviewer for RED articles)
 */
app.patch('/api/articles/:id', async (req: Request, res: Response) => {
  try {
    const article = await prisma.article.findUnique({
      where: { id: req.params.id },
    });

    if (!article) {
      return res.status(404).json({ success: false, error: 'Article not found' });
    }

    const { content } = req.body as { content?: string };
    if (typeof content !== 'string' || content.trim() === '') {
      return res.status(400).json({ success: false, error: 'content is required' });
    }

    const contentHtml = await marked.parse(content);

    const updated = await prisma.article.update({
      where: { id: req.params.id },
      data: { content, contentHtml },
    });

    res.json({ success: true, data: { ...updated, images: parseImages(updated.images) } });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/**
 * DELETE /api/articles/:id
 * Discard an article
 */
app.delete('/api/articles/:id', async (req: Request, res: Response) => {
  try {
    const article = await prisma.article.findUnique({
      where: { id: req.params.id },
    });

    if (!article) {
      return res.status(404).json({ success: false, error: 'Article not found' });
    }

    await prisma.article.delete({ where: { id: req.params.id } });
    res.json({ success: true, data: { id: req.params.id } });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

// ============================================================
// Pipeline Routes
// ============================================================

/**
 * GET /api/pipeline/status
 * Current pipeline run status
 */
app.get('/api/pipeline/status', async (_req: Request, res: Response) => {
  try {
    const running = isPipelineRunning();

    // Active run: most recent RUNNING record (only meaningful when isRunning is true)
    const currentRun = running
      ? await prisma.pipelineRun.findFirst({
          where: { status: 'RUNNING' },
          orderBy: { startedAt: 'desc' },
        })
      : null;

    // Last completed/failed/aborted run
    const lastRun = await prisma.pipelineRun.findFirst({
      where: { status: { in: ['COMPLETED', 'FAILED', 'ABORTED'] } },
      orderBy: { completedAt: 'desc' },
    });

    res.json({
      success: true,
      data: {
        isRunning: running,
        currentRun: currentRun
          ? { ...currentRun, logs: parseLogs(currentRun.logs) }
          : null,
        lastRun: lastRun
          ? { ...lastRun, logs: parseLogs(lastRun.logs) }
          : null,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/**
 * POST /api/pipeline/trigger
 * Manually trigger a pipeline run
 */
app.post('/api/pipeline/trigger', async (_req: Request, res: Response) => {
  if (isPipelineRunning()) {
    return res.status(409).json({
      success: false,
      error: 'Pipeline is already running',
    });
  }

  // Trigger async — don't await, respond immediately
  runPipeline().catch((err) => {
    console.error('[API] Pipeline trigger error:', err);
  });

  res.json({ success: true, data: { message: 'Pipeline triggered successfully' } });
});

/**
 * POST /api/pipeline/abort
 * Abort the currently running pipeline
 */
app.post('/api/pipeline/abort', async (_req: Request, res: Response) => {
  if (!isPipelineRunning()) {
    return res.status(409).json({ success: false, error: 'No pipeline is currently running' });
  }
  const aborted = await abortPipeline();
  res.json({ success: true, data: { aborted } });
});

/**
 * GET /api/pipeline/logs
 * Get logs from the most recent pipeline run (polling endpoint)
 */
app.get('/api/pipeline/logs', async (_req: Request, res: Response) => {
  try {
    const latestRun = await prisma.pipelineRun.findFirst({
      orderBy: { startedAt: 'desc' },
    });

    if (!latestRun) {
      return res.json({ success: true, data: { logs: [], runId: null } });
    }

    res.json({
      success: true,
      data: {
        runId: latestRun.id,
        status: latestRun.status,
        logs: parseLogs(latestRun.logs),
        articlesProcessed: latestRun.articlesProcessed,
        startedAt: latestRun.startedAt,
        completedAt: latestRun.completedAt,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/**
 * GET /api/dashboard/stats
 * Aggregate stats for the dashboard
 */
app.get('/api/dashboard/stats', async (_req: Request, res: Response) => {
  try {
    const articles = await prisma.article.findMany({
      select: { status: true, pillar: true },
    });

    const stats = {
      total: articles.length,
      green: articles.filter((a) => a.status === 'GREEN').length,
      yellow: articles.filter((a) => a.status === 'YELLOW').length,
      red: articles.filter((a) => a.status === 'RED').length,
      processing: articles.filter((a) => a.status === 'PROCESSING').length,
      published: articles.filter((a) => a.status === 'PUBLISHED').length,
      failed: articles.filter((a) => a.status === 'FAILED').length,
      byPillar: {
        anime: articles.filter((a) => a.pillar === 'anime').length,
        gaming: articles.filter((a) => a.pillar === 'gaming').length,
        infotainment: articles.filter((a) => a.pillar === 'infotainment').length,
        manga: articles.filter((a) => a.pillar === 'manga').length,
        toys: articles.filter((a) => a.pillar === 'toys').length,
      },
    };

    res.json({ success: true, data: stats });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

// ============================================================
// Serve frontend static files (built into ../public relative to dist/)
// Falls back to a JSON health-check when public dir isn't present.
// ============================================================
const publicDir = path.join(__dirname, '..', 'public');
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
  app.get('*', (_req: Request, res: Response) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });
  console.log('[Server] Serving frontend from', publicDir);
} else {
  app.get('/', (_req: Request, res: Response) => {
    res.json({ status: 'ok', service: 'synthetic-newsroom-backend', api: '/api' });
  });
}

// ============================================================
// Error Handler
// ============================================================
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[Server] Unhandled error:', err);
  res.status(500).json({ success: false, error: err.message });
});

// ============================================================
// Start Server
// ============================================================
async function main(): Promise<void> {
  await prisma.$connect();
  console.log('[Server] Database connected.');

  // ── Autonomous pipeline cron ──────────────────────────────────
  const CRON_SCHEDULE = process.env.PIPELINE_CRON_SCHEDULE || '0 */8 * * *';
  cron.schedule(CRON_SCHEDULE, async () => {
    console.log('[CRON] Initiating autonomous newsroom run...');
    try {
      await runPipeline();
    } catch (error) {
      console.error('[CRON] Pipeline run failed:', error);
    }
  });
  console.log(`[CRON] Pipeline scheduled: "${CRON_SCHEDULE}" (override with PIPELINE_CRON_SCHEDULE env var)`);
  // ─────────────────────────────────────────────────────────────

  app.listen(PORT, () => {
    console.log(`[Server] Running on http://localhost:${PORT}`);

    // ── Run pipeline once immediately on startup ──────────────────
    const RUN_ON_STARTUP = process.env.PIPELINE_RUN_ON_STARTUP !== 'false';
    if (RUN_ON_STARTUP) {
      console.log('[Startup] Triggering initial pipeline run...');
      runPipeline().catch((err) => {
        console.error('[Startup] Initial pipeline run failed:', err);
      });
    }
    // ─────────────────────────────────────────────────────────────
  });
}

main().catch((err) => {
  console.error('[Server] Fatal startup error:', err);
  process.exit(1);
});

export default app;
