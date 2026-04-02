/**
 * Pipeline Orchestrator
 *
 * Orchestrates the 4-agent pipeline:
 * Scout → Researcher → Copywriter → Editor (revision loop)
 *
 * Implements the full state machine including:
 * - Scout quota enforcement with feedback loop
 * - Researcher rejection routing back to Scout
 * - Editor revision loops (max 3)
 * - Article status determination (GREEN/YELLOW/RED/FAILED)
 * - WordPress auto-publishing for GREEN articles
 */

import { PrismaClient } from '@prisma/client';
import { marked } from 'marked';
import { Scout } from './agents/scout';
import { Researcher } from './agents/researcher';
import { Copywriter } from './agents/copywriter';
import { Editor } from './agents/editor';
import { publishArticle } from './services/wordpress';
import { PILLARS } from '../../shared/types';
import type {
  Pillar,
  ScoutItem,
  ResearchedItem,
  DraftArticle,
  PipelineLogEntry,
} from '../../shared/types';

const MAX_REVISION_LOOPS = 3;
const ARTICLES_PER_PILLAR = 2; // Target successes per pillar per run

export class Pipeline {
  private prisma: PrismaClient;
  private scout: Scout;
  private researcher: Researcher;
  private copywriter: Copywriter;
  private editor: Editor;
  private runId: string | null = null;
  private logs: PipelineLogEntry[] = [];
  private abortSignal: AbortSignal | null = null;
  private onRunId: ((id: string) => void) | null = null;

  constructor(prisma: PrismaClient, abortSignal?: AbortSignal, onRunId?: (id: string) => void) {
    this.prisma = prisma;
    this.abortSignal = abortSignal ?? null;
    this.onRunId = onRunId ?? null;
    this.scout = new Scout(prisma, (msg) => this.addLog(msg, 'info', 'Scout'));
    this.researcher = new Researcher((msg) => this.addLog(msg, 'info', 'Researcher'));
    this.copywriter = new Copywriter((msg) => this.addLog(msg, 'info', 'Copywriter'));
    this.editor = new Editor((msg) => this.addLog(msg, 'info', 'Editor'));
  }

  private checkAbort(): void {
    if (this.abortSignal?.aborted) {
      throw new Error('ABORTED');
    }
  }

  private addLog(
    message: string,
    level: PipelineLogEntry['level'] = 'info',
    agent?: string
  ): void {
    const entry: PipelineLogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      agent,
    };
    this.logs.push(entry);
    const prefix = agent ? `[${agent}]` : '[Pipeline]';
    console.log(`${prefix} ${message}`);
    // Persist logs to DB asynchronously so the dashboard sees live updates
    this.persistLogs().catch(() => {});
  }

  private async persistLogs(): Promise<void> {
    if (!this.runId) return;
    await this.prisma.pipelineRun.update({
      where: { id: this.runId },
      data: { logs: JSON.stringify(this.logs) },
    });
  }

  /**
   * Create a new article record in the database.
   */
  private async createArticleRecord(item: ScoutItem): Promise<string> {
    const article = await this.prisma.article.create({
      data: {
        title: item.title,
        pillar: item.pillar,
        sourceUrl: item.link,
        status: 'PROCESSING',
        revisionCount: 0,
      },
    });
    return article.id;
  }

  /**
   * Extract the first H1 headline from Markdown content.
   * Returns null if no H1 is found.
   */
  private extractH1(markdown: string): string | null {
    const match = markdown.match(/^#\s+(.+)$/m);
    return match ? match[1].trim() : null;
  }

  /**
   * Update article status and content in the database.
   */
  private async updateArticle(
    id: string,
    data: {
      title?: string;
      status?: string;
      content?: string;
      contentHtml?: string;
      images?: string;
      editorNotes?: string;
      revisionCount?: number;
      wpPostId?: number;
      wpPostUrl?: string;
    }
  ): Promise<void> {
    await this.prisma.article.update({ where: { id }, data });
  }

  /**
   * Run the full revision loop for a single article.
   * Returns the final status.
   */
  private async processArticle(
    articleId: string,
    item: ResearchedItem
  ): Promise<'GREEN' | 'YELLOW' | 'RED' | 'FAILED'> {
    let draft: DraftArticle | null = null;
    let revisionCount = 0;
    let lastEditorFeedback = '';
    let currentImages = item.images;
    let indonesianTitle: string | null = null;

    for (let attempt = 0; attempt <= MAX_REVISION_LOOPS; attempt++) {
      // Check abort before each revision attempt
      this.checkAbort();

      // 3-strike rule: after 3 failed revision loops, mark RED for human review
      if (attempt >= MAX_REVISION_LOOPS) {
        this.addLog(
          `Article "${item.title}" exhausted ${MAX_REVISION_LOOPS} revision loops. Marking RED for human review.`,
          'warn',
          'Pipeline'
        );

        await this.updateArticle(articleId, {
          status: 'RED',
          revisionCount,
          editorNotes: lastEditorFeedback,
        });
        return 'RED';
      }

      // Write or rewrite draft
      if (draft === null) {
        draft = await this.copywriter.writeDraft({ ...item, images: currentImages });
      } else {
        draft = await this.copywriter.rewrite(
          { ...item, images: currentImages },
          lastEditorFeedback,
          currentImages
        );
      }

      // Check for Copywriter routing signal (broken images detected in editor feedback)
      if (draft.content.trim().startsWith('SYSTEM_ROUTE_TO_RESEARCHER')) {
        this.addLog(`Copywriter signaled new images required for "${item.title}" — routing to Researcher`, 'warn', 'Pipeline');
        const existingUrls = new Set(currentImages.map((img) => img.url));
        const newImages = await this.researcher.findImages(item.title, item.pillar, existingUrls);
        if (newImages.length > 0) {
          currentImages = newImages;
          this.addLog(`Replaced images for "${item.title}" (${newImages.length} new)`, 'info', 'Researcher');
        } else {
          this.addLog(`Could not find replacement images for "${item.title}"`, 'warn', 'Researcher');
        }
        revisionCount++;
        lastEditorFeedback = '';
        draft = null;
        continue;
      }

      // Extract Indonesian headline from Copywriter's H1 and update DB title
      const extractedTitle = this.extractH1(draft.content);
      if (extractedTitle) {
        indonesianTitle = extractedTitle;
        this.addLog(`[Copywriter] Indonesian headline: "${indonesianTitle}"`, 'info', 'Copywriter');
      }

      // Save draft to DB
      const contentHtml = await marked.parse(draft.content);
      await this.updateArticle(articleId, {
        ...(indonesianTitle ? { title: indonesianTitle } : {}),
        content: draft.content,
        contentHtml,
        images: JSON.stringify(currentImages),
        revisionCount,
      });

      // Editor review
      const editorResult = await this.editor.review(draft, revisionCount);

      if (editorResult.passed) {
        let finalContent = draft.content;
        let finalHtml = contentHtml;

        // Apply auto-fix if needed
        if (editorResult.autoFixed && editorResult.fixedContent) {
          this.addLog(`Auto-fixing minor issues in "${item.title}"`, 'info', 'Editor');
          finalContent = editorResult.fixedContent;
          finalHtml = await marked.parse(finalContent);
        }

        // Determine final status
        const status = this.editor.determineStatus(true, editorResult.autoFixed, revisionCount);
        this.addLog(`Article "${item.title}" passed editor review. Status: ${status}`, 'info', 'Editor');

        await this.updateArticle(articleId, {
          status,
          content: finalContent,
          contentHtml: finalHtml,
          revisionCount,
          editorNotes: editorResult.feedback,
        });

        // Auto-publish GREEN articles to WordPress using Indonesian title
        if (status === 'GREEN') {
          const publishTitle = indonesianTitle || item.title;
          await this.tryPublishToWordPress(articleId, publishTitle, finalHtml, currentImages, item.pillar);
        }

        return status;
      }

      // Failed — classify the failure type
      lastEditorFeedback = editorResult.feedback;
      revisionCount++;

      this.addLog(
        `Article "${item.title}" failed review (attempt ${attempt + 1}/${MAX_REVISION_LOOPS}) [${editorResult.issueType}] — ${editorResult.feedback}`,
        'warn',
        'Editor'
      );

      // UNSALVAGEABLE: Editor declared topic dead after max attempts — exit immediately
      if (editorResult.issueType === 'UNSALVAGEABLE') {
        this.addLog(
          `Article "${item.title}" declared UNSALVAGEABLE. Marking RED for human review — Scout will find a replacement.`,
          'warn',
          'Pipeline'
        );
        await this.updateArticle(articleId, {
          status: 'RED',
          revisionCount,
          editorNotes: editorResult.feedback,
        });
        return 'RED';
      }

      // Image issues — get new images from Researcher
      if (editorResult.issueType === 'IMAGE') {
        this.addLog(`Fetching replacement images for "${item.title}"...`, 'info', 'Researcher');
        const existingUrls = new Set(currentImages.map((img) => img.url));
        const newImages = await this.researcher.findImages(item.title, item.pillar, existingUrls);
        if (newImages.length > 0) {
          currentImages = newImages;
          this.addLog(`Replaced images for "${item.title}" (${newImages.length} new)`, 'info', 'Researcher');
        } else {
          this.addLog(`Could not find replacement images for "${item.title}"`, 'warn', 'Researcher');
        }
      }

      // Update DB with failure state
      await this.updateArticle(articleId, {
        status: 'PROCESSING',
        revisionCount,
        editorNotes: lastEditorFeedback,
      });
    }

    // Should not reach here, but safety fallback
    return 'FAILED';
  }

  /**
   * Attempt to publish an article to WordPress.
   * Catches errors gracefully — publishing failure does not block the pipeline.
   */
  private async tryPublishToWordPress(
    articleId: string,
    title: string,
    contentHtml: string,
    images: Array<{ url: string; alt: string; isFeatured: boolean }>,
    pillar?: Pillar
  ): Promise<void> {
    if (!process.env.WP_BASE_URL && !process.env.WP_URL) {
      this.addLog('WordPress not configured — skipping auto-publish', 'info', 'Pipeline');
      return;
    }

    try {
      this.addLog(`Publishing "${title}" to WordPress...`, 'info', 'WordPress');
      const { wpPostId, wpPostUrl } = await publishArticle(title, contentHtml, images, pillar);

      await this.updateArticle(articleId, {
        status: 'PUBLISHED',
        wpPostId,
        wpPostUrl,
      });

      this.addLog(`Published "${title}" to WordPress. Post ID: ${wpPostId}`, 'info', 'WordPress');
    } catch (err) {
      this.addLog(
        `WordPress publish failed for "${title}": ${(err as Error).message}. Article remains GREEN.`,
        'warn',
        'WordPress'
      );
      // Article stays GREEN even if WP publish fails — human can manually publish
    }
  }

  /**
   * Dynamic per-pillar queue.
   * Processes candidates one by one until the success quota is met.
   * If a topic is UNSALVAGEABLE the next candidate is tried automatically.
   * Returns the number of articles that reached GREEN or YELLOW.
   */
  private async runPillarQueue(
    pillar: Pillar,
    candidates: ScoutItem[],
    target: number
  ): Promise<number> {
    let successCount = 0;

    for (const topic of candidates) {
      if (successCount >= target) break;
      this.checkAbort();

      this.addLog(
        `[${pillar}] Processing candidate (${successCount}/${target} done): "${topic.title}"`,
        'info',
        'Pipeline'
      );

      // Research
      const researched = await this.researcher.researchItem(topic);
      if (!researched.approved) {
        this.addLog(`[${pillar}] Researcher rejected "${topic.title}" — trying next candidate`, 'warn', 'Researcher');
        await this.scout.markProcessed(topic.link);
        continue;
      }

      // Create DB record and process
      const articleId = await this.createArticleRecord(topic);
      const finalStatus = await this.processArticle(articleId, researched);
      await this.scout.markProcessed(topic.link);

      this.addLog(`Completed article "${topic.title}". Final status: ${finalStatus}`, 'info', 'Pipeline');
      await this.persistLogs();

      if (finalStatus === 'GREEN' || finalStatus === 'YELLOW') {
        successCount++;
        this.addLog(
          `[${pillar}] Success ${successCount}/${target}: "${topic.title}"`,
          'info',
          'Pipeline'
        );
      } else {
        // RED = did not reach GREEN/YELLOW — topic auto-discarded, next candidate queued
        this.addLog(
          `[${pillar}] Topic did not pass (${finalStatus}): "${topic.title}" — fetching replacement from candidate pool`,
          'warn',
          'Pipeline'
        );
      }
    }

    if (successCount < target) {
      this.addLog(
        `[${pillar}] Candidate pool exhausted — achieved ${successCount}/${target} successes`,
        'warn',
        'Pipeline'
      );
    }

    return successCount;
  }

  /**
   * Main pipeline run.
   *
   * Phase 1 — Scout collects a large candidate pool for all pillars.
   * Phase 2 — Each pillar runs its own dynamic queue:
   *   • Articles go through Researcher → Copywriter → Editor (max 3 attempts).
   *   • UNSALVAGEABLE articles are discarded; the next candidate is tried automatically.
   *   • The queue stops when the pillar hits its success quota or runs out of candidates.
   */
  async run(): Promise<{ runId: string; articlesProcessed: number }> {
    this.logs = [];

    const pipelineRun = await this.prisma.pipelineRun.create({
      data: { status: 'RUNNING' },
    });
    this.runId = pipelineRun.id;
    this.onRunId?.(this.runId);
    this.addLog(`Pipeline run started. ID: ${this.runId}`, 'info', 'Pipeline');

    let articlesProcessed = 0;

    try {
      // ── Phase 1: Scout ────────────────────────────────────────────────────
      this.addLog('Scout collecting candidate pool for all pillars...', 'info', 'Pipeline');
      const allCandidates = await this.scout.run();

      // Group candidates by pillar
      const candidatesByPillar: Record<Pillar, ScoutItem[]> = {
        anime: allCandidates.filter((i) => i.pillar === 'anime'),
        gaming: allCandidates.filter((i) => i.pillar === 'gaming'),
        infotainment: allCandidates.filter((i) => i.pillar === 'infotainment'),
        manga: allCandidates.filter((i) => i.pillar === 'manga'),
        toys: allCandidates.filter((i) => i.pillar === 'toys'),
      };

      for (const pillar of PILLARS) {
        this.addLog(
          `Scout found ${candidatesByPillar[pillar].length} candidates for ${pillar}`,
          'info',
          'Pipeline'
        );
      }

      // ── Phase 2: Per-pillar dynamic queues (run in parallel) ─────────────
      const pillarResults = await Promise.all(
        PILLARS.map((pillar) =>
          this.runPillarQueue(pillar, candidatesByPillar[pillar], ARTICLES_PER_PILLAR)
        )
      );

      articlesProcessed = pillarResults.reduce((sum, count) => sum + count, 0);

      await this.prisma.pipelineRun.update({
        where: { id: this.runId },
        data: {
          status: 'COMPLETED',
          articlesProcessed,
          completedAt: new Date(),
          logs: JSON.stringify(this.logs),
        },
      });

      this.addLog(
        `Pipeline run completed. ${articlesProcessed} articles published/queued.`,
        'info',
        'Pipeline'
      );
    } catch (err) {
      const isAbort = (err as Error).message === 'ABORTED';
      this.addLog(
        isAbort ? 'Pipeline aborted by user.' : `Pipeline run failed: ${(err as Error).message}`,
        isAbort ? 'warn' : 'error',
        'Pipeline'
      );

      await this.prisma.pipelineRun.update({
        where: { id: this.runId! },
        data: {
          status: isAbort ? 'ABORTED' : 'FAILED',
          articlesProcessed,
          completedAt: new Date(),
          logs: JSON.stringify(this.logs),
        },
      });

      throw err;
    }

    return { runId: this.runId, articlesProcessed };
  }
}
