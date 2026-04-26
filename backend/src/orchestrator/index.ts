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
import { Scout }              from '../agents/scout';
import { UnderquotaProtocol } from '../agents/scout-underquota';
import { Researcher }        from '../agents/researcher';
import { Editor }            from '../agents/editor';
import { Publisher }              from '../agents/publisher/index';
import { SocialMediaOrchestrator } from '../agents/social_media/orchestrator';
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
import { PILLARS, PILLAR_LABELS }        from '../shared/types';
import { TopicBank }                     from '../services/topic-bank';
import type {
  Pillar,
  ScoutItem,
  ResearchedItem,
  DraftArticle,
  PipelineLogEntry,
} from '../shared/types';

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

/**
 * How many published articles per pillar per pipeline run get sent through
 * the Social Media Coordinator pipeline.  3 × 5 pillars = 15 social posts max per run.
 */
const MAX_SOCIAL_POSTS_PER_PILLAR = 3;

/** Consecutive empty Scout rounds before giving up on quota. */
const MAX_SCOUT_EMPTY_ROUNDS = 3;

/**
 * Jaccard title-similarity threshold above which two articles are treated
 * as covering the same topic.  0.30 means ~30% token overlap.
 * e.g. "Tami Koi announces new single" vs "Tami Koi reveals debut album"
 * → shared tokens: {tami, koi} / union of 6 unique tokens = 0.33 → DUPLICATE
 */
const DEDUP_SIMILARITY_THRESHOLD = 0.30;

/**
 * How far back to look in the Article DB when checking for cross-run
 * topic duplicates. Articles published within this window block a new
 * article about the same topic.
 */
const DEDUP_WINDOW_HOURS = 24;

// ── Topic-deduplication utilities ─────────────────────────────────────────────

const DEDUP_STOP_WORDS = new Set([
  // English
  'the','a','an','is','are','was','were','of','in','on','at','to','for','by','with','and','or','new',
  // Indonesian
  'dan','yang','di','ke','dari','dengan','untuk','ini','itu','akan','telah','sudah','juga','baru','terbaru',
]);

/** Tokenise a title into a set of meaningful lowercase words. */
function titleTokens(title: string): Set<string> {
  return new Set(
    title.toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 2 && !DEDUP_STOP_WORDS.has(t))
  );
}

/** Jaccard similarity between two token sets (0 = no overlap, 1 = identical). */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersect = 0;
  for (const t of a) if (b.has(t)) intersect++;
  return intersect / (a.size + b.size - intersect);
}

// ── Shared copywriter interface ───────────────────────────────────────────────
interface CopywriterAgent {
  readonly personaName: string;
  readonly wpAuthorId:  number;
  writeDraft(item: ResearchedItem, editorFeedback?: string): Promise<DraftArticle>;
  rewrite(item: ResearchedItem, editorFeedback: string, newImages?: Array<{ url: string; alt: string; isFeatured: boolean; sourceQuery?: string }>): Promise<DraftArticle>;
}

// ── Orchestrator class ────────────────────────────────────────────────────────
export class Orchestrator {
  private prisma:             PrismaClient;
  private scout:              Scout;
  private underquotaProtocol: UnderquotaProtocol;
  private researcher:         Researcher;
  private editor:             Editor;
  private publisher:          Publisher;
  private copywriters:              Record<Pillar, CopywriterAgent>;
  private socialMediaOrchestrator:  SocialMediaOrchestrator;
  private socialPostCountByPillar:  Map<string, number> = new Map();
  private socialMediaTasks:         Promise<void>[]     = [];
  private runId:                    string | null = null;
  private logs:                     PipelineLogEntry[] = [];
  private abortSignal:              AbortSignal | null = null;
  private onRunId:                  ((id: string) => void) | null = null;
  /** Titles (scout + Indonesian) of topics started in the current run.
   *  Used for Jaccard-based same-run deduplication against topic titles. */
  private publishedThisRun: Array<{ title: string; pillar: string }> = [];
  /** Source URLs of every topic we have started processing this run.
   *  A URL-exact check that catches same-story duplicates whose titles differ
   *  enough to slip under the Jaccard threshold (e.g. same natalie.mu URL
   *  picked up by two different RSS feeds with differently-worded headlines). */
  private processedLinksThisRun: Set<string> = new Set();

  constructor(prisma: PrismaClient, abortSignal?: AbortSignal, onRunId?: (id: string) => void) {
    this.prisma      = prisma;
    this.abortSignal = abortSignal ?? null;
    this.onRunId     = onRunId    ?? null;

    // ── Specialized Agent instances ───────────────────────────────────────────
    this.scout              = new Scout(prisma, (msg) => this.addLog(msg, 'info', 'Scout'));
    this.underquotaProtocol = new UnderquotaProtocol(prisma, (msg) => this.addLog(msg, 'info', 'Underquota'));
    this.researcher         = new Researcher((msg) => this.addLog(msg, 'info', 'Researcher'));
    this.editor     = new Editor((msg) => this.addLog(msg, 'info', 'Editor'));
    this.publisher  = new Publisher((msg) => this.addLog(msg, 'info', 'Publisher'));
    this.socialMediaOrchestrator = new SocialMediaOrchestrator(
      prisma,
      (msg) => this.addLog(msg, 'info', 'Social')
    );

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

  /**
   * Topic-level deduplication across all pillar buckets.
   *
   * Two articles are considered duplicates when their titles share ≥30% token
   * overlap (Jaccard).  Two dedup passes run in sequence:
   *
   *   Pass 1 — Cross-run memory (8-hour DB window):
   *     Compare each bucket item against articles already published/processing
   *     in the last DEDUP_WINDOW_HOURS.  If the DB already has an article about
   *     "Tami Koi", new Scout items about "Tami Koi" are dropped.
   *
   *   Pass 2 — Within-batch dedup:
   *     Compare bucket items against each other.  If Natalie, 4Gamer, and
   *     Automaton all filed stories about "Tami Koi" in the same Scout sweep,
   *     keep the first one encountered and drop the other two.
   *
   * Dropped items are discarded (not banked) since they represent genuinely
   * redundant topics.  Any pillar whose count falls below TARGET after dedup
   * will naturally trigger another Scout dispatch via the quota loop.
   *
   * @param buckets        Per-pillar candidate buckets (mutated in-place)
   * @param recentTitles   Pre-fetched articles from the last 8 h (cross-run check)
   * @param target         Per-pillar quota cap (used for log messages)
   */
  private deduplicateBuckets(
    buckets:      Record<Pillar, ScoutItem[]>,
    recentTitles: Array<{ title: string; pillar: string }>,
    target:       number
  ): void {
    // ── Pre-pass: cross-pillar URL dedup ──────────────────────────────────────
    // The same source URL can appear in multiple pillar buckets if two RSS feeds
    // filed the same story under different categories.  Jaccard won't catch this
    // when the titles are worded differently enough.  Remove the second occurrence
    // across pillars (keep the first pillar that claimed it).
    const seenUrls = new Set<string>();
    let urlDupCount = 0;
    for (const pillar of PILLARS) {
      const before = buckets[pillar].length;
      buckets[pillar] = buckets[pillar].filter((item) => {
        if (seenUrls.has(item.link)) {
          this.addLog(
            `[Brain] Cross-pillar URL dup [${pillar}]: "${item.title}" — source already queued in another pillar`,
            'warn',
            ORCHESTRATOR_IDENTITY
          );
          return false;
        }
        seenUrls.add(item.link);
        return true;
      });
      urlDupCount += before - buckets[pillar].length;
    }
    if (urlDupCount > 0) {
      this.addLog(
        `[Brain] URL pre-pass removed ${urlDupCount} cross-pillar duplicate(s) by source URL`,
        'warn',
        ORCHESTRATOR_IDENTITY
      );
    }

    // Pre-tokenise recent DB articles grouped by pillar
    const recentByPillar: Partial<Record<string, Array<{ title: string; tokens: Set<string> }>>> = {};
    for (const article of recentTitles) {
      if (!recentByPillar[article.pillar]) recentByPillar[article.pillar] = [];
      recentByPillar[article.pillar]!.push({
        title:  article.title,
        tokens: titleTokens(article.title),
      });
    }

    let totalRemoved = 0;

    for (const pillar of PILLARS) {
      const bucket = buckets[pillar];
      if (bucket.length < 2) continue;

      const tokenSets   = bucket.map((item) => titleTokens(item.title));
      const isDuplicate = new Array<boolean>(bucket.length).fill(false);

      // ── Pass 1: Cross-run memory check ─────────────────────────────────────
      const recentForPillar = recentByPillar[pillar] ?? [];
      for (let i = 0; i < bucket.length; i++) {
        if (isDuplicate[i]) continue;
        for (const recent of recentForPillar) {
          const sim = jaccardSimilarity(tokenSets[i], recent.tokens);
          if (sim >= DEDUP_SIMILARITY_THRESHOLD) {
            isDuplicate[i] = true;
            this.addLog(
              `[Brain] Cross-run dup [${pillar}] (${(sim * 100).toFixed(0)}% match): ` +
              `"${bucket[i].title}" already covered by recent → "${recent.title}"`,
              'warn',
              ORCHESTRATOR_IDENTITY
            );
            break;
          }
        }
      }

      // ── Pass 2: Within-batch dedup ─────────────────────────────────────────
      for (let i = 0; i < bucket.length; i++) {
        if (isDuplicate[i]) continue;
        for (let j = i + 1; j < bucket.length; j++) {
          if (isDuplicate[j]) continue;
          const sim = jaccardSimilarity(tokenSets[i], tokenSets[j]);
          if (sim >= DEDUP_SIMILARITY_THRESHOLD) {
            isDuplicate[j] = true;
            this.addLog(
              `[Brain] Within-batch dup [${pillar}] (${(sim * 100).toFixed(0)}% match): ` +
              `"${bucket[j].title}" dropped — duplicate of → "${bucket[i].title}"`,
              'warn',
              ORCHESTRATOR_IDENTITY
            );
          }
        }
      }

      const kept:    ScoutItem[] = [];
      const dropped: ScoutItem[] = [];
      for (let i = 0; i < bucket.length; i++) {
        (isDuplicate[i] ? dropped : kept).push(bucket[i]);
      }

      if (dropped.length > 0) {
        buckets[pillar] = kept;
        totalRemoved   += dropped.length;
        this.addLog(
          `[Brain] Dedup [${pillar}]: kept ${kept.length}, removed ${dropped.length} duplicate(s)` +
          ` — bucket now ${kept.length}/${target}` +
          (kept.length < target ? ` (${target - kept.length} more needed)` : ''),
          'warn',
          ORCHESTRATOR_IDENTITY
        );
      }
    }

    if (totalRemoved > 0) {
      this.addLog(
        `[Brain] Topic dedup complete — ${totalRemoved} duplicate(s) removed across all pillars. ` +
        `Underquota check will re-dispatch Scout for any deficit pillars.`,
        'info',
        ORCHESTRATOR_IDENTITY
      );
    }
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

  /**
   * Extract the explicit short article title written by the Copywriter.
   * Format: `**Judul:** text here` (first occurrence in the draft).
   * Returns null if the line is absent — caller falls back to H1.
   */
  private extractJudul(markdown: string): string | null {
    const match = markdown.match(/^\*\*Judul:\*\*\s*(.+)$/m);
    return match ? match[1].trim() : null;
  }

  /**
   * Remove the `**Judul:**` line (and one optional blank line after it) from
   * the draft so it isn't stored in the article body.
   */
  private stripJudul(markdown: string): string {
    return markdown.replace(/\*\*Judul:\*\*[^\n]*\n{0,2}/, '');
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
  ): Promise<{ buckets: Record<Pillar, ScoutItem[]>; bank: TopicBank; recentArticles: Array<{ title: string; pillar: string }> }> {
    const TARGET = TARGET_CANDIDATES_PER_PILLAR;

    // ── Load Brain ────────────────────────────────────────────────────────────
    const bank = new TopicBank();
    await bank.load((msg) => this.addLog(msg, 'info', ORCHESTRATOR_IDENTITY));

    // Prune topics whose URLs are already in the ProcessedUrl table
    const processed    = await this.prisma.processedUrl.findMany({ select: { url: true } });
    const processedSet = new Set(processed.map((p) => p.url));
    const pruned       = bank.pruneProcessed(processedSet);
    if (pruned > 0) {
      this.addLog(`[Brain] Pruned ${pruned} already-processed topic(s) from bank`, 'info', ORCHESTRATOR_IDENTITY);
    }

    const buckets: Record<Pillar, ScoutItem[]> = {
      anime: [], gaming: [], infotainment: [], manga: [], toys: [],
    };

    // ── Pre-fill buckets from Brain ───────────────────────────────────────────
    let totalRecalled = 0;
    for (const pillar of PILLARS) {
      if (bank.getAvailableCount(pillar) > 0) {
        const recalled = bank.recall(pillar, TARGET);
        buckets[pillar].push(...recalled);
        totalRecalled += recalled.length;
      }
    }
    if (totalRecalled > 0) {
      const state = PILLARS
        .map((p) => `${PILLAR_LABELS[p].replace('Japanese ', '')}:${buckets[p].length}/${TARGET}`)
        .join('  ');
      this.addLog(
        `[Brain] Pre-filled ${totalRecalled} pre-triaged topic(s) from bank | ${state}`,
        'info',
        ORCHESTRATOR_IDENTITY
      );
    }

    // Overflow accumulator — approved Scout items that don't fit in full buckets
    const overflow: ScoutItem[] = [];

    const isQuotaMet    = () => PILLARS.every((p) => buckets[p].length >= TARGET);
    const getMissing    = () => PILLARS.filter((p) => buckets[p].length < TARGET);

    /** Slot Scout results into pillar buckets; Master enforces the cap. */
    const processHandover = (newTopics: ScoutItem[]): void => {
      let slotted = 0;
      for (const topic of newTopics) {
        if (buckets[topic.pillar].length < TARGET) {
          buckets[topic.pillar].push(topic);
          slotted++;
        } else {
          overflow.push(topic); // bucket full → bank for future runs
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

    // ── Pre-fetch recent articles for cross-run topic dedup ──────────────────
    // Queries articles created within the last DEDUP_WINDOW_HOURS so the Brain
    // can prevent re-covering a topic from the previous pipeline run.
    const dedupCutoff    = new Date(Date.now() - DEDUP_WINDOW_HOURS * 3_600_000);
    const recentArticles = await this.prisma.article.findMany({
      where: {
        createdAt: { gte: dedupCutoff },
        // Explicitly include all non-failure statuses so published articles
        // block re-coverage of the same topic within the 24-hour window.
        status: { in: ['PROCESSING', 'GREEN', 'YELLOW', 'PUBLISHED'] },
      },
      select: { title: true, pillar: true },
    });
    if (recentArticles.length > 0) {
      this.addLog(
        `[Brain] ${recentArticles.length} article(s) from the last ${DEDUP_WINDOW_HOURS}h ` +
        `(incl. published) loaded for topic deduplication.`,
        'info',
        ORCHESTRATOR_IDENTITY
      );
    }

    // ── Round 1: Broad scrape from PRIORITY_FEEDS ───────────────────────────
    this.addLog(
      `[Master] Initialising 50-slot quota (${TARGET}/pillar). Dispatching Scout — Round 1 (Broad Scrape)...`,
      'info',
      ORCHESTRATOR_IDENTITY
    );
    dispatchAgent('scout', 'all pillars', (msg) => this.addLog(msg, 'info', ORCHESTRATOR_IDENTITY));

    const round1Topics = await this.scout.run({ mode: 'round_1' }, rejectedUrls);
    processHandover(round1Topics);
    this.deduplicateBuckets(buckets, recentArticles, TARGET);

    // ── Underquota Protocol loop ────────────────────────────────────────────
    //
    // Activated when Round 1 leaves any pillar below quota.
    // The UnderquotaProtocol targets PRIORITY_FEEDS entries whose tags match
    // the deficit pillar(s), building a focused pool of up to 50 items per
    // dispatch.  No fallback escalation occurs here — if the tagged priority
    // feeds are exhausted, the Master proceeds with whatever quota was reached.
    //
    let scoutRound  = 2;
    let emptyRounds = 0;

    while (!isQuotaMet() && scoutRound <= MAX_SCOUT_ROUNDS) {
      this.checkAbort();

      const missingPillars = getMissing();
      const missingLabels  = missingPillars.map((p) => PILLAR_LABELS[p]);
      const deficit        = missingPillars
        .map((p) => `${PILLAR_LABELS[p].replace('Japanese ', '')}(${TARGET - buckets[p].length} needed)`)
        .join(', ');

      this.addLog(
        `[Master] Quota deficit: ${deficit} — dispatching Underquota Protocol round ${scoutRound}`,
        'warn',
        ORCHESTRATOR_IDENTITY
      );

      dispatchAgent('scout', missingLabels.join(', '), (msg) =>
        this.addLog(msg, 'info', ORCHESTRATOR_IDENTITY)
      );

      const newTopics = await this.underquotaProtocol.run(missingLabels, rejectedUrls);

      if (newTopics.length === 0) {
        emptyRounds++;
        this.addLog(
          `[Master] Underquota Protocol returned 0 results (${emptyRounds}/${MAX_SCOUT_EMPTY_ROUNDS} empty rounds)`,
          'warn',
          ORCHESTRATOR_IDENTITY
        );

        if (emptyRounds >= MAX_SCOUT_EMPTY_ROUNDS) {
          this.addLog(
            '[Master] Underquota Protocol exhausted — proceeding with partial quota.',
            'warn',
            ORCHESTRATOR_IDENTITY
          );
          break;
        }
      } else {
        emptyRounds = 0;
        processHandover(newTopics);
        this.deduplicateBuckets(buckets, recentArticles, TARGET);
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

    // ── Bank overflow topics for future runs ──────────────────────────────────
    if (overflow.length > 0) {
      const added = bank.add(overflow);
      this.addLog(
        `[Brain] ${added} overflow topic(s) banked` +
        (overflow.length - added > 0 ? ` (${overflow.length - added} duplicate(s) skipped)` : ''),
        'info',
        ORCHESTRATOR_IDENTITY
      );
    }

    return { buckets, bank, recentArticles };
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

      // Extract article title: prefer explicit **Judul:** line, fall back to H1
      const extractedJudul = this.extractJudul(draft.content);
      const extractedH1    = this.extractH1(draft.content);
      const resolvedTitle  = extractedJudul ?? extractedH1;
      if (resolvedTitle) {
        indonesianTitle = resolvedTitle;
        this.addLog(
          `[${personaName}] Article title (${extractedJudul ? 'Judul' : 'H1 fallback'}): "${indonesianTitle}"`,
          'info',
          personaName
        );
      }

      // Strip Judul line then H1 from body so neither duplicates the stored title
      const bodyContent = this.stripH1(this.stripJudul(draft.content));
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

        // Register this title in the same-run memory so parallel/later
        // queues don't re-cover the same topic within this pipeline run.
        const completedTitle = indonesianTitle || item.title;
        this.publishedThisRun.push({ title: completedTitle, pillar: item.pillar });

        // GREEN + YELLOW → dispatch Publisher (YELLOW = passed after revisions, still publish)
        if (status === 'GREEN' || status === 'YELLOW') {
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

      // ── Social Media Coordinator (fire-and-forget, 3 per pillar cap) ─────────
      const socialCount = this.socialPostCountByPillar.get(pillar) ?? 0;
      if (socialCount < MAX_SOCIAL_POSTS_PER_PILLAR) {
        const featuredImage = images.find((img) => img.isFeatured) ?? images[0];
        if (featuredImage) {
          this.socialPostCountByPillar.set(pillar, socialCount + 1);
          this.addLog(
            `[Social] Queuing pipeline for "${title}" (${socialCount + 1}/${MAX_SOCIAL_POSTS_PER_PILLAR} for ${pillar})`,
            'info',
            ORCHESTRATOR_IDENTITY
          );
          const task = this.socialMediaOrchestrator
            .runForArticle({
              articleId,
              pillar,
              featuredImageUrl: featuredImage.url,
              wpPostUrl,
            })
            .catch((err: Error) =>
              this.addLog(
                `[Social] Pipeline failed for "${title}": ${err.message}`,
                'warn',
                ORCHESTRATOR_IDENTITY
              )
            );
          this.socialMediaTasks.push(task);
        }
      }
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
    pillar:       Pillar,
    candidates:   ScoutItem[],
    target:       number,
    bank:         TopicBank,
    recentTitles: Array<{ title: string; pillar: string }>
  ): Promise<number> {
    const persona    = this.copywriters[pillar].personaName;
    let successCount = 0;

    // Recall brain backup upfront — only reached after main candidates are exhausted.
    // We recall up to `target` extra items so we have a meaningful reserve.
    const brainBackup  = bank.recall(pillar, target);
    const fullQueue    = [...candidates, ...brainBackup];
    let   brainLogged  = false;
    let   processedIdx = 0; // how many items we actually started on (for banking untried)

    for (const topic of fullQueue) {
      if (successCount >= target) break;
      this.checkAbort();

      const isBrainItem = processedIdx >= candidates.length;

      // Announce the first time we cross into brain territory
      if (isBrainItem && !brainLogged) {
        brainLogged = true;
        this.addLog(
          `[Brain] Main queue exhausted — recalling ${brainBackup.length} banked topic(s) for ${pillar}`,
          'info',
          ORCHESTRATOR_IDENTITY
        );
      }

      processedIdx++;

      // ── Runtime dedup: URL-exact check first, then Jaccard title check ────────
      // Catches duplicates that slipped through the scouting-phase dedup:
      // brain-backup items, topics banked from previous runs, or topics whose
      // counterpart was published by a parallel pillar queue in this same run.

      // 1. URL-exact: same source URL = same story, regardless of headline wording.
      if (this.processedLinksThisRun.has(topic.link)) {
        this.addLog(
          `[Brain] URL dedup [${pillar}]: "${topic.title}" — source URL already processed this run → discarded`,
          'warn',
          ORCHESTRATOR_IDENTITY
        );
        await this.scout.markProcessed(topic.link);
        continue;
      }

      // 2. Jaccard title similarity: catches same IP reported by different sources.
      const topicTokens = titleTokens(topic.title);
      const allRecent   = [...recentTitles, ...this.publishedThisRun];
      const dupMatch    = allRecent.find((recent) =>
        jaccardSimilarity(topicTokens, titleTokens(recent.title)) >= DEDUP_SIMILARITY_THRESHOLD
      );
      if (dupMatch) {
        this.addLog(
          `[Brain] Runtime dedup [${pillar}]: "${topic.title}" ` +
          `matches recent → "${dupMatch.title}" — discarded`,
          'warn',
          ORCHESTRATOR_IDENTITY
        );
        await this.scout.markProcessed(topic.link);
        continue;
      }
      // ─────────────────────────────────────────────────────────────────────────

      this.addLog(
        `[${pillar}/${persona}${isBrainItem ? ' ·Brain' : ''}] Processing candidate (${successCount}/${target}): "${topic.title}"`,
        'info',
        ORCHESTRATOR_IDENTITY
      );

      // Pre-register this topic immediately — enforces 1-IP/Pillar/Pipeline-run rule.
      // Both the source URL and the scout title are locked in here so that:
      //   • processedLinksThisRun blocks same-URL duplicates (URL-exact match)
      //   • publishedThisRun blocks same-IP duplicates (Jaccard title match)
      // Either check blocks a later candidate regardless of whether this attempt
      // ends up RED or FAILED.
      this.processedLinksThisRun.add(topic.link);
      this.publishedThisRun.push({ title: topic.title, pillar });

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

    // Bank any items we never reached (quota hit early or pool exhausted with leftover brain items)
    const untriedItems = fullQueue.slice(processedIdx);
    if (untriedItems.length > 0) {
      const added = bank.add(untriedItems);
      if (added > 0) {
        this.addLog(
          `[Brain] ${added} untried topic(s) from ${pillar} returned to bank`,
          'info',
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
    this.logs                    = [];
    this.socialPostCountByPillar = new Map(); // reset per-run social post quota
    this.socialMediaTasks        = [];        // reset per-run social task registry
    this.publishedThisRun        = [];
    this.processedLinksThisRun   = new Set();

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
      //
      // The TopicBank (Brain) pre-fills buckets with previously-triaged topics
      // before any Scout round, so the Scout only fills remaining slots.
      const { buckets: candidatesByPillar, bank, recentArticles } = await this.orchestrateScoutingPhase();

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
          this.runPillarQueue(pillar, candidatesByPillar[pillar], ARTICLES_PER_PILLAR, bank, recentArticles)
        )
      );

      // ── Save Brain after all queues complete ─────────────────────────────────
      await bank.save((msg) => this.addLog(msg, 'info', ORCHESTRATOR_IDENTITY));

      articlesProcessed = pillarResults.reduce((sum, count) => sum + count, 0);

      // ── Phase 3: Await all social media tasks ─────────────────────────────────
      // Social tasks were queued fire-and-forget during Phase 2 so they don't
      // block individual article processing. We collect them and await here so
      // the worker thread doesn't exit before social posts complete.
      if (this.socialMediaTasks.length > 0) {
        this.addLog(
          `[Social] Awaiting ${this.socialMediaTasks.length} social media pipeline(s)…`,
          'info',
          ORCHESTRATOR_IDENTITY
        );
        await Promise.allSettled(this.socialMediaTasks);
        this.addLog('[Social] All social media pipelines complete.', 'info', ORCHESTRATOR_IDENTITY);
      }

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
