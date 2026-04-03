/**
 * Master Orchestrator (Agent 0)
 *
 * The central brain of the Synthetic Newsroom. Coordinates the full
 * multi-agent pipeline by explicitly dispatching each Specialized Agent,
 * tracking the article state machine, and streaming updates to the Dashboard.
 *
 * Workforce dispatched by the Orchestrator:
 *   Scout        → RSS ingestion + freshness triage
 *   Researcher   → Source crawl + fact extraction + image sourcing
 *   Satoshi      → Anime copywriting       (WP Author 2)
 *   Hikari       → Gaming copywriting      (WP Author 3)
 *   Kenji        → Infotainment copywriting (WP Author 4)
 *   Rina         → Manga copywriting       (WP Author 5)
 *   Taro         → Toys copywriting        (WP Author 6)
 *   Editor       → Editorial review + 3-strike rule
 *   Publisher    → WordPress delivery + author/category assignment
 *
 * See orchestrator/prompt.ts for the full workflow specification.
 */

import { PrismaClient }      from '@prisma/client';
import { marked }            from 'marked';
import { Scout }             from '../agents/scout';
import type { ScoutPayload } from '../agents/scout';
import { Researcher }        from '../agents/researcher';
import { Editor }            from '../agents/editor';
import { Publisher }         from '../agents/publisher/index';
import { AnimeSatoshi }      from '../agents/copywriters/anime_satoshi/index';
import { GamingHikari }      from '../agents/copywriters/gaming_hikari/index';
import { InfotainmentKenji } from '../agents/copywriters/infotainment_kenji/index';
import { MangaRina }         from '../agents/copywriters/manga_rina/index';
import { ToysTaro }          from '../agents/copywriters/toys_taro/index';
import {
  dispatchAgent,
  PILLAR_AGENT_MAP,
} from './tools/dispatch_agent';

import { updateUI, updateArticleState } from './tools/update_ui';
import { ORCHESTRATOR_IDENTITY }        from './prompt';
import { PILLARS, PILLAR_LABELS }        from '../../../shared/types';
import type {
  Pillar,
  ScoutItem,
  ResearchedItem,
  DraftArticle,
  PipelineLogEntry,
} from '../../../shared/types';

// ── Constants ─────────────────────────────────────────────────────────────────
const MAX_REVISION_LOOPS  = 3;

/**
 * How many Scout candidates the Master must collect per pillar before
 * advancing to the Researcher phase (50 total across all 5 pillars).
 */
const TARGET_CANDIDATES_PER_PILLAR = 10;

/**
 * How many successfully published (GREEN/YELLOW) articles the Master
 * targets per pillar per pipeline run (50 total).
 */
const ARTICLES_PER_PILLAR = 10;

/** Safety cap on the number of Scout dispatch rounds in the underquota loop. */
const MAX_SCOUT_ROUNDS    = 10;

/** Consecutive empty Scout rounds before giving up on quota. */
const MAX_SCOUT_EMPTY_ROUNDS = 3;

// ── Shared copywriter interface ───────────────────────────────────────────────
interface CopywriterAgent {
  readonly personaName: string;
  readonly wpAuthorId:  number;
  writeDraft(item: ResearchedItem, editorFeedback?: string): Promise<DraftArticle>;
  rewrite(item: ResearchedItem, editorFeedback: string, newImages?: Array<{ url: string; alt: string; isFeatured: boolean; sourceQuery?: string }>): Promise<DraftArticle>;
}

// ── Orchestrator class ────────────────────────────────────────────────────────
export class Orchestrator {
  private prisma:      PrismaClient;
  private scout:       Scout;
  private researcher:  Researcher;
  private editor:      Editor;
  private publisher:   Publisher;
  private copywriters: Record<Pillar, CopywriterAgent>;
  private runId:       string | null = null;
  private logs:        PipelineLogEntry[] = [];
  private abortSignal: AbortSignal | null = null;
  private onRunId:     ((id: string) => void) | null = null;

  constructor(prisma: PrismaClient, abortSignal?: AbortSignal, onRunId?: (id: string) => void) {
    this.prisma      = prisma;
    this.abortSignal = abortSignal ?? null;
    this.onRunId     = onRunId    ?? null;

    // ── Specialized Agent instances ───────────────────────────────────────────
    this.scout      = new Scout(prisma, (msg) => this.addLog(msg, 'info', 'Scout'));
    this.researcher = new Researcher((msg) => this.addLog(msg, 'info', 'Researcher'));
    this.editor     = new Editor((msg) => this.addLog(msg, 'info', 'Editor'));
    this.publisher  = new Publisher((msg) => this.addLog(msg, 'info', 'Publisher'));

    // ── Pillar → Copywriter dispatch map ──────────────────────────────────────
    this.copywriters = {
      anime:        new AnimeSatoshi((msg)      => this.addLog(msg, 'info', 'Satoshi')),
      gaming:       new GamingHikari((msg)      => this.addLog(msg, 'info', 'Hikari')),
      infotainment: new InfotainmentKenji((msg) => this.addLog(msg, 'info', 'Kenji')),
      manga:        new MangaRina((msg)          => this.addLog(msg, 'info', 'Rina')),
      toys:         new ToysTaro((msg)           => this.addLog(msg, 'info', 'Taro')),
    };
  }

  // ── Internal helpers ──────────────────────────────────────────────────────────

  private checkAbort(): void {
    if (this.abortSignal?.aborted) throw new Error('ABORTED');
  }

  private addLog(
    message: string,
    level:   PipelineLogEntry['level'] = 'info',
    agent?:  string
  ): void {
    const entry: PipelineLogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      agent,
    };
    this.logs.push(entry);
    const prefix = agent ? `[${agent}]` : `[${ORCHESTRATOR_IDENTITY}]`;
    console.log(`${prefix} ${message}`);
    if (this.runId) updateUI(this.prisma, this.runId, this.logs);
  }

  private async createArticleRecord(item: ScoutItem): Promise<string> {
    const article = await this.prisma.article.create({
      data: {
        title:         item.title,
        pillar:        item.pillar,
        sourceUrl:     item.link,
        status:        'PROCESSING',
        revisionCount: 0,
      },
    });
    return article.id;
  }

  private extractH1(markdown: string): string | null {
    const match = markdown.match(/^#\s+(.+)$/m);
    return match ? match[1].trim() : null;
  }

  /** Remove the leading H1 line from markdown so the stored body doesn't duplicate the article title. */
  private stripH1(markdown: string): string {
    return markdown.replace(/^#\s+[^\n]+\n?/, '').trimStart();
  }

  // ── Master scouting phase ─────────────────────────────────────────────────────

  /**
   * Master Orchestrator's scouting phase — the sole brain of the quota loop.
   *
   * The Scout is a pure data-retriever: it fetches feeds, triages items, and
   * returns candidates. It does NOT track quotas or manage loops.
   *
   * Flow:
   *   1. Master dispatches Scout (round_1) → broad PRIORITY_FEEDS scrape.
   *   2. Master slots approved topics into per-pillar buckets (caps at TARGET).
   *   3. If any pillar is still short: Master re-dispatches Scout with
   *      underquota_protocol (then fallback_protocol after round 4).
   *   4. Continues until all 5 × TARGET_CANDIDATES_PER_PILLAR slots are
   *      filled, feeds are exhausted, or MAX_SCOUT_ROUNDS is reached.
   *   5. Master then passes the full candidate set to the Researcher phase.
   */
  private async orchestrateScoutingPhase(
    rejectedUrls: Set<string> = new Set()
  ): Promise<Record<Pillar, ScoutItem[]>> {
    const TARGET = TARGET_CANDIDATES_PER_PILLAR;

    const buckets: Record<Pillar, ScoutItem[]> = {
      anime: [], gaming: [], infotainment: [], manga: [], toys: [],
    };

    const isQuotaMet    = () => PILLARS.every((p) => buckets[p].length >= TARGET);
    const getMissing    = () => PILLARS.filter((p) => buckets[p].length < TARGET);

    /** Slot Scout results into pillar buckets; Master enforces the cap. */
    const processHandover = (newTopics: ScoutItem[]): void => {
      let slotted = 0;
      for (const topic of newTopics) {
        if (buckets[topic.pillar].length < TARGET) {
          buckets[topic.pillar].push(topic);
          slotted++;
        }
      }
      const state = PILLARS
        .map((p) => `${PILLAR_LABELS[p].replace('Japanese ', '')}:${buckets[p].length}/${TARGET}`)
        .join('  ');
      this.addLog(
        `[Master] Handover processed — ${slotted} new slot(s) filled | ${state}`,
        'info',
        ORCHESTRATOR_IDENTITY
      );
    };

    // ── Round 1: Broad scrape from PRIORITY_FEEDS ───────────────────────────
    this.addLog(
      `[Master] Initialising 50-slot quota (${TARGET}/pillar). Dispatching Scout — Round 1 (Broad Scrape)...`,
      'info',
      ORCHESTRATOR_IDENTITY
    );
    dispatchAgent('scout', 'all pillars', (msg) => this.addLog(msg, 'info', ORCHESTRATOR_IDENTITY));

    const round1Topics = await this.scout.run({ mode: 'round_1' }, rejectedUrls);
    processHandover(round1Topics);

    // ── Underquota / Fallback loop ──────────────────────────────────────────
    //
    // Protocol escalation is driven by results, not by round number:
    //   1. Always start with underquota_protocol (Tier 1 — subpillar feeds).
    //   2. After MAX_SCOUT_EMPTY_ROUNDS consecutive empty underquota rounds,
    //      escalate once to fallback_protocol (Tier 3 — widest net).
    //   3. After MAX_SCOUT_EMPTY_ROUNDS consecutive empty fallback rounds,
    //      all feeds are exhausted — proceed with partial quota.
    //
    let scoutRound        = 2;
    let emptyRounds       = 0;
    let useUnderquota     = true; // true → underquota_protocol, false → fallback_protocol

    while (!isQuotaMet() && scoutRound <= MAX_SCOUT_ROUNDS) {
      this.checkAbort();

      const missingPillars = getMissing();
      const missingLabels  = missingPillars.map((p) => PILLAR_LABELS[p]);
      const deficit        = missingPillars
        .map((p) => `${PILLAR_LABELS[p].replace('Japanese ', '')}(${TARGET - buckets[p].length} needed)`)
        .join(', ');

      const mode: ScoutPayload['mode'] = useUnderquota
        ? 'underquota_protocol'
        : 'fallback_protocol';

      this.addLog(
        `[Master] Quota deficit: ${deficit} — dispatching Scout round ${scoutRound} [${mode}]`,
        'warn',
        ORCHESTRATOR_IDENTITY
      );

      dispatchAgent('scout', missingLabels.join(', '), (msg) =>
        this.addLog(msg, 'info', ORCHESTRATOR_IDENTITY)
      );

      const newTopics = await this.scout.run(
        { mode, missing_pillars: missingLabels },
        rejectedUrls
      );

      if (newTopics.length === 0) {
        emptyRounds++;
        this.addLog(
          `[Master] Scout returned 0 results (${emptyRounds}/${MAX_SCOUT_EMPTY_ROUNDS} empty rounds)`,
          'warn',
          ORCHESTRATOR_IDENTITY
        );

        if (emptyRounds >= MAX_SCOUT_EMPTY_ROUNDS) {
          if (useUnderquota) {
            // Underquota feeds exhausted — escalate to fallback
            useUnderquota = false;
            emptyRounds   = 0;
            this.addLog(
              '[Master] Underquota feeds exhausted — escalating to Fallback Protocol (Tier 3).',
              'warn',
              ORCHESTRATOR_IDENTITY
            );
          } else {
            // Fallback feeds also exhausted — nothing more to try
            this.addLog(
              '[Master] All feeds exhausted — proceeding with partial quota.',
              'warn',
              ORCHESTRATOR_IDENTITY
            );
            break;
          }
        }
      } else {
        emptyRounds = 0;
        processHandover(newTopics);
      }

      scoutRound++;
    }

    // ── Final quota report ──────────────────────────────────────────────────
    const total = PILLARS.reduce((sum, p) => sum + buckets[p].length, 0);
    if (isQuotaMet()) {
      this.addLog(
        `[Master] 50-Article Quota Fulfilled! ${total} candidates ready. Proceeding to Researcher Phase.`,
        'info',
        ORCHESTRATOR_IDENTITY
      );
    } else {
      const state = PILLARS
        .map((p) => `${PILLAR_LABELS[p].replace('Japanese ', '')}:${buckets[p].length}/${TARGET}`)
        .join('  ');
      this.addLog(
        `[Master] Partial quota — ${total}/50 candidates collected (${state}). Proceeding.`,
        'warn',
        ORCHESTRATOR_IDENTITY
      );
    }

    return buckets;
  }

  // ── Article revision loop ─────────────────────────────────────────────────────

  /**
   * Orchestrates the full revision loop for a single article.
   *
   * The Orchestrator explicitly dispatches each agent at every decision point,
   * making its coordination visible in the log stream.
   */
  private async processArticle(
    articleId:  string,
    item:       ResearchedItem
  ): Promise<'GREEN' | 'YELLOW' | 'RED' | 'FAILED'> {
    const agentHandle  = PILLAR_AGENT_MAP[item.pillar];
    const copywriter   = this.copywriters[item.pillar];
    const personaName  = copywriter.personaName;

    dispatchAgent(agentHandle, item.title, (msg) => this.addLog(msg, 'info', ORCHESTRATOR_IDENTITY));

    let draft:              DraftArticle | null = null;
    let revisionCount                           = 0;
    let lastEditorFeedback                      = '';
    let currentImages                           = item.images;
    let indonesianTitle:    string | null       = null;

    for (let attempt = 0; attempt <= MAX_REVISION_LOOPS; attempt++) {
      this.checkAbort();

      // 3-strike rule
      if (attempt >= MAX_REVISION_LOOPS) {
        this.addLog(
          `"${item.title}" exhausted ${MAX_REVISION_LOOPS} revision loops → RED`,
          'warn',
          ORCHESTRATOR_IDENTITY
        );
        await updateArticleState(this.prisma, articleId, {
          status: 'RED', revisionCount, editorNotes: lastEditorFeedback,
        });
        return 'RED';
      }

      // ── Dispatch Copywriter ──────────────────────────────────────────────────
      if (draft === null) {
        draft = await copywriter.writeDraft({ ...item, images: currentImages });
      } else {
        // Rewrite — Orchestrator routes feedback back to the same Copywriter
        this.addLog(
          `Routing revision feedback back to ${personaName} (attempt ${attempt + 1}/${MAX_REVISION_LOOPS})`,
          'info',
          ORCHESTRATOR_IDENTITY
        );
        dispatchAgent(agentHandle, item.title, (msg) => this.addLog(msg, 'info', ORCHESTRATOR_IDENTITY));
        draft = await copywriter.rewrite(
          { ...item, images: currentImages },
          lastEditorFeedback,
          currentImages
        );
      }

      // Copywriter routing signal: broken images → re-dispatch Researcher
      if (draft.content.trim().startsWith('SYSTEM_ROUTE_TO_RESEARCHER')) {
        this.addLog(
          `${personaName} detected broken images — re-dispatching Researcher for replacements`,
          'warn',
          ORCHESTRATOR_IDENTITY
        );
        dispatchAgent('researcher', item.title, (msg) => this.addLog(msg, 'info', ORCHESTRATOR_IDENTITY));
        const existingUrls = new Set(currentImages.map((img) => img.url));
        const newImages    = await this.researcher.findImages(item.title, item.pillar, existingUrls);
        if (newImages.length > 0) {
          currentImages = newImages;
          this.addLog(`Researcher returned ${newImages.length} replacement images`, 'info', 'Researcher');
        } else {
          this.addLog('Researcher could not find replacement images', 'warn', 'Researcher');
        }
        revisionCount++;
        lastEditorFeedback = '';
        draft              = null;
        continue;
      }

      // Extract Indonesian headline
      const extractedTitle = this.extractH1(draft.content);
      if (extractedTitle) {
        indonesianTitle = extractedTitle;
        this.addLog(`[${personaName}] Indonesian headline: "${indonesianTitle}"`, 'info', personaName);
      }

      // Persist draft via update_ui — strip H1 from body so it doesn't duplicate the title field
      const bodyContent = this.stripH1(draft.content);
      const contentHtml = await marked.parse(bodyContent);
      await updateArticleState(this.prisma, articleId, {
        ...(indonesianTitle ? { title: indonesianTitle } : {}),
        content:       bodyContent,
        contentHtml,
        images:        JSON.stringify(currentImages),
        revisionCount,
      });

      // ── Dispatch Editor ──────────────────────────────────────────────────────
      dispatchAgent('editor', item.title, (msg) => this.addLog(msg, 'info', ORCHESTRATOR_IDENTITY));
      const editorResult = await this.editor.review(draft, revisionCount);

      if (editorResult.passed) {
        // bodyContent is already stripped; if the editor auto-fixed, strip its output too
        let finalContent = bodyContent;
        let finalHtml    = contentHtml;

        if (editorResult.autoFixed && editorResult.fixedContent) {
          this.addLog(`Editor applied auto-fix to "${item.title}"`, 'info', 'Editor');
          finalContent = this.stripH1(editorResult.fixedContent);
          finalHtml    = await marked.parse(finalContent);
        }

        const status = this.editor.determineStatus(true, editorResult.autoFixed, revisionCount);
        this.addLog(
          `Editor PASS → status: ${status} (${personaName}, attempt ${revisionCount + 1})`,
          'info',
          ORCHESTRATOR_IDENTITY
        );

        await updateArticleState(this.prisma, articleId, {
          status, content: finalContent, contentHtml: finalHtml,
          revisionCount, editorNotes: editorResult.feedback,
        });

        // GREEN → dispatch Publisher
        if (status === 'GREEN') {
          const publishTitle = indonesianTitle || item.title;
          await this.tryPublish(articleId, publishTitle, finalHtml, currentImages, item.pillar, personaName);
        }

        return status;
      }

      // ── Editor FAIL ──────────────────────────────────────────────────────────
      lastEditorFeedback = editorResult.feedback;
      revisionCount++;

      this.addLog(
        `Editor FAIL (attempt ${attempt + 1}/${MAX_REVISION_LOOPS}) [${editorResult.issueType}]: ${editorResult.feedback}`,
        'warn',
        ORCHESTRATOR_IDENTITY
      );

      // UNSALVAGEABLE → exit immediately
      if (editorResult.issueType === 'UNSALVAGEABLE') {
        this.addLog(`"${item.title}" UNSALVAGEABLE → RED`, 'warn', ORCHESTRATOR_IDENTITY);
        await updateArticleState(this.prisma, articleId, {
          status: 'RED', revisionCount, editorNotes: editorResult.feedback,
        });
        return 'RED';
      }

      // IMAGE failure → re-dispatch Researcher for new images
      if (editorResult.issueType === 'IMAGE') {
        this.addLog(
          `Image failure — re-dispatching Researcher for "${item.title}"`,
          'info',
          ORCHESTRATOR_IDENTITY
        );
        dispatchAgent('researcher', item.title, (msg) => this.addLog(msg, 'info', ORCHESTRATOR_IDENTITY));
        const existingUrls = new Set(currentImages.map((img) => img.url));
        const newImages    = await this.researcher.findImages(item.title, item.pillar, existingUrls);
        if (newImages.length > 0) {
          currentImages = newImages;
          this.addLog(`Researcher returned ${newImages.length} replacement images`, 'info', 'Researcher');
        } else {
          this.addLog('Researcher could not find replacement images', 'warn', 'Researcher');
        }
      }

      await updateArticleState(this.prisma, articleId, {
        status: 'PROCESSING', revisionCount, editorNotes: lastEditorFeedback,
      });
    }

    return 'FAILED';
  }

  // ── Publisher dispatch ────────────────────────────────────────────────────────

  private async tryPublish(
    articleId:   string,
    title:       string,
    contentHtml: string,
    images:      Array<{ url: string; alt: string; isFeatured: boolean; sourceQuery?: string }>,
    pillar:      Pillar,
    authorName:  string
  ): Promise<void> {
    if (!process.env.WP_BASE_URL && !process.env.WP_URL) {
      this.addLog('WordPress not configured — skipping auto-publish', 'info', ORCHESTRATOR_IDENTITY);
      return;
    }

    dispatchAgent('publisher', title, (msg) => this.addLog(msg, 'info', ORCHESTRATOR_IDENTITY));

    try {
      const { wpPostId, wpPostUrl } = await this.publisher.publish({
        title, contentHtml, images, pillar, authorName,
      });
      await updateArticleState(this.prisma, articleId, {
        status: 'PUBLISHED', wpPostId, wpPostUrl,
      });
      this.addLog(
        `Published "${title}" by ${authorName} → Post ID ${wpPostId} | ${wpPostUrl}`,
        'info',
        ORCHESTRATOR_IDENTITY
      );
    } catch (err) {
      this.addLog(
        `Publisher failed for "${title}": ${(err as Error).message} — article remains GREEN`,
        'warn',
        ORCHESTRATOR_IDENTITY
      );
    }
  }

  // ── Per-pillar queue ──────────────────────────────────────────────────────────

  private async runPillarQueue(
    pillar:     Pillar,
    candidates: ScoutItem[],
    target:     number
  ): Promise<number> {
    const persona    = this.copywriters[pillar].personaName;
    let successCount = 0;

    for (const topic of candidates) {
      if (successCount >= target) break;
      this.checkAbort();

      this.addLog(
        `[${pillar}/${persona}] Processing candidate (${successCount}/${target}): "${topic.title}"`,
        'info',
        ORCHESTRATOR_IDENTITY
      );

      // Dispatch Researcher
      dispatchAgent('researcher', topic.title, (msg) => this.addLog(msg, 'info', ORCHESTRATOR_IDENTITY));
      const researched = await this.researcher.researchItem(topic);

      if (!researched.approved) {
        this.addLog(
          `Researcher rejected "${topic.title}" — trying next candidate`,
          'warn',
          ORCHESTRATOR_IDENTITY
        );
        await this.scout.markProcessed(topic.link);
        continue;
      }

      const articleId   = await this.createArticleRecord(topic);
      const finalStatus = await this.processArticle(articleId, researched);
      await this.scout.markProcessed(topic.link);

      this.addLog(
        `[${pillar}/${persona}] Completed "${topic.title}" → ${finalStatus}`,
        'info',
        ORCHESTRATOR_IDENTITY
      );
      if (this.runId) updateUI(this.prisma, this.runId, this.logs);

      if (finalStatus === 'GREEN' || finalStatus === 'YELLOW') {
        successCount++;
        this.addLog(
          `[${pillar}/${persona}] ✓ Success ${successCount}/${target}: "${topic.title}"`,
          'info',
          ORCHESTRATOR_IDENTITY
        );
      } else {
        this.addLog(
          `[${pillar}/${persona}] ✗ ${finalStatus}: "${topic.title}" — fetching next candidate`,
          'warn',
          ORCHESTRATOR_IDENTITY
        );
      }
    }

    if (successCount < target) {
      this.addLog(
        `[${pillar}/${persona}] Pool exhausted — ${successCount}/${target} successes`,
        'warn',
        ORCHESTRATOR_IDENTITY
      );
    }

    return successCount;
  }

  // ── Main run ──────────────────────────────────────────────────────────────────

  /**
   * Full pipeline run orchestrated by the Master Agent.
   *
   * Phase 1 — Scout dispatch
   *   Orchestrator dispatches Scout to build 10 candidates per pillar.
   *
   * Phase 2 — Per-pillar parallel queues
   *   Orchestrator dispatches all 5 pillar queues simultaneously.
   *   Each queue: Researcher → Copywriter (persona) → Editor → Publisher (GREEN).
   */
  async run(): Promise<{ runId: string; articlesProcessed: number }> {
    this.logs = [];

    const pipelineRun = await this.prisma.pipelineRun.create({
      data: { status: 'RUNNING' },
    });
    this.runId = pipelineRun.id;
    this.onRunId?.(this.runId);

    this.addLog(`${ORCHESTRATOR_IDENTITY} online. Run ID: ${this.runId}`, 'info', ORCHESTRATOR_IDENTITY);
    this.addLog(
      'Workforce: Scout | Researcher | Satoshi(anime) | Hikari(gaming) | Kenji(info) | Rina(manga) | Taro(toys) | Editor | Publisher',
      'info',
      ORCHESTRATOR_IDENTITY
    );

    let articlesProcessed = 0;

    try {
      // ── Phase 1: Master-controlled Scout scouting phase ─────────────────────
      //
      // The Master Orchestrator is the sole brain of the quota loop.
      // orchestrateScoutingPhase() dispatches the Scout one or more times
      // (round_1 → underquota_protocol → fallback_protocol) until all 5 pillar
      // buckets hold TARGET_CANDIDATES_PER_PILLAR (10) candidates each,
      // feeds are exhausted, or MAX_SCOUT_ROUNDS is reached.
      const candidatesByPillar = await this.orchestrateScoutingPhase();

      for (const pillar of PILLARS) {
        const persona = this.copywriters[pillar].personaName;
        this.addLog(
          `[Master] ${candidatesByPillar[pillar].length}/${TARGET_CANDIDATES_PER_PILLAR} candidates for ${pillar} → ${persona}`,
          'info',
          ORCHESTRATOR_IDENTITY
        );
      }

      // ── Phase 2: Per-pillar parallel queues ─────────────────────────────────
      this.addLog('Dispatching all 5 pillar queues in parallel...', 'info', ORCHESTRATOR_IDENTITY);
      const pillarResults = await Promise.all(
        PILLARS.map((pillar) =>
          this.runPillarQueue(pillar, candidatesByPillar[pillar], ARTICLES_PER_PILLAR)
        )
      );

      articlesProcessed = pillarResults.reduce((sum, count) => sum + count, 0);

      await this.prisma.pipelineRun.update({
        where: { id: this.runId },
        data:  {
          status:            'COMPLETED',
          articlesProcessed,
          completedAt:       new Date(),
          logs:              JSON.stringify(this.logs),
        },
      });

      this.addLog(
        `${ORCHESTRATOR_IDENTITY} complete. ${articlesProcessed} articles published/queued.`,
        'info',
        ORCHESTRATOR_IDENTITY
      );
    } catch (err) {
      const isAbort = (err as Error).message === 'ABORTED';
      this.addLog(
        isAbort ? 'Pipeline aborted by user.' : `Run failed: ${(err as Error).message}`,
        isAbort ? 'warn' : 'error',
        ORCHESTRATOR_IDENTITY
      );

      await this.prisma.pipelineRun.update({
        where: { id: this.runId! },
        data:  {
          status:            isAbort ? 'ABORTED' : 'FAILED',
          articlesProcessed,
          completedAt:       new Date(),
          logs:              JSON.stringify(this.logs),
        },
      });

      throw err;
    }

    return { runId: this.runId, articlesProcessed };
  }
}
