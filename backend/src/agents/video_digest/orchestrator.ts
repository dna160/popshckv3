import { PrismaClient } from '@prisma/client';
import { PILLARS }      from '../../shared/types';
import type { Pillar, Storyboard, EditorVerdict, ArticleRecord } from './types';
import { Scripter }       from './scripter';
import { Editor }         from './editor';
import { Voiceover }      from './voiceover';
import { VideoGenerator } from './video_generator';
import { Compositor }     from './compositor';
import { VideoPublisher } from './publisher';

const MAX_ROUNDS = 3;

// Parse the images JSON string stored on Article to find the featured image URL.
function getFeaturedImageUrl(imagesJson: string | null): string {
  if (!imagesJson) return '';
  try {
    const imgs = JSON.parse(imagesJson) as Array<{ url: string; isFeatured?: boolean }>;
    const featured = imgs.find(img => img.isFeatured) || imgs[0];
    return featured?.url || '';
  } catch {
    return '';
  }
}

export class VideoDigestOrchestrator {
  private prisma:        PrismaClient;
  private scripter:      Scripter;
  private editor:        Editor;
  private voiceover:     Voiceover;
  private videoGen:      VideoGenerator;
  private compositor:    Compositor;
  private publisher:     VideoPublisher;

  constructor(prisma: PrismaClient) {
    this.prisma     = prisma;
    this.scripter   = new Scripter();
    this.editor     = new Editor();
    this.voiceover  = new Voiceover();
    this.videoGen   = new VideoGenerator();
    this.compositor = new Compositor();
    this.publisher  = new VideoPublisher();
  }

  async run(runId: string): Promise<void> {
    console.log(`[VDP] Starting Video Digest Pipeline for runId=${runId}`);
    await Promise.allSettled(
      PILLARS.map(pillar => this.runForPillar(runId, pillar))
    );
    console.log(`[VDP] All pillar pipelines settled for runId=${runId}`);
  }

  private async runForPillar(runId: string, pillar: Pillar): Promise<void> {
    const digest = await this.prisma.videoDigest.create({
      data: { runId, pillar, status: 'PROCESSING' },
    });

    try {
      // Phase 1: Collect
      const articles = await this.collectArticles(pillar);
      if (articles.length === 0) {
        throw new Error(`No published articles found for pillar ${pillar}`);
      }

      // Phase 2+3: Script + Editorial Gate (up to 3 rounds)
      const storyboard = await this.scriptWithEditor(pillar, articles);

      // Phase 4: Voiceover
      const audio = await this.voiceover.generate(storyboard);
      this.validateAudioDurations(audio);

      // Phase 5: Video generation (Grok I2V per article segment)
      const video = await this.videoGen.generate(storyboard, audio);

      // Phase 6: FFmpeg assembly
      const composed = await this.compositor.assemble(pillar, storyboard, audio, video);

      // Phase 7: Publish to IG Reels + Stories
      const published = await this.publisher.publish(composed);

      // articleIds is String[] on PostgreSQL, String (JSON) on SQLite.
      // Serialize to JSON string so it's accepted by both schema variants.
      const articleIdPayload = JSON.stringify(articles.map(a => a.id));
      await this.prisma.videoDigest.update({
        where: { id: digest.id },
        data:  {
          status:          'POSTED',
          articleIds:      articleIdPayload as any,
          voiceoverScript: storyboard.segments.map(s => s.scriptLine).join(' '),
          caption:         storyboard.caption,
          reelVideoUrl:    published.wpMediaUrl,
          storyVideoUrl:   published.wpMediaUrl,
          igReelId:        published.reelId,
          igStoryId:       published.storyId,
          postedAt:        new Date(),
        },
      });

      console.log(`[VDP] pillar=${pillar} POSTED — reel=${published.reelId} story=${published.storyId}`);
    } catch (err) {
      const msg = (err as Error).message;
      await this.prisma.videoDigest.update({
        where: { id: digest.id },
        data:  { status: 'FAILED', errorLog: msg },
      });
      console.error(`[VDP] pillar=${pillar} FAILED: ${msg}`);
    }
  }

  private async collectArticles(pillar: Pillar): Promise<ArticleRecord[]> {
    const rows = await this.prisma.article.findMany({
      where:   { status: 'PUBLISHED', pillar },
      orderBy: { createdAt: 'desc' },
      take:    3,
      select:  { id: true, title: true, content: true, images: true, wpPostUrl: true },
    });

    // Reject articles without a featured image
    return rows.filter(a => getFeaturedImageUrl(a.images) !== '');
  }

  private async scriptWithEditor(
    pillar:   Pillar,
    articles: ArticleRecord[]
  ): Promise<Storyboard> {
    // Enrich articles with featured image URLs for the Scripter
    const enriched = articles.map(a => ({
      ...a,
      featuredImageUrl: getFeaturedImageUrl(a.images),
    }));

    let storyboard: Storyboard | null = null;
    let lastVerdict: EditorVerdict | null = null;

    for (let round = 0; round < MAX_ROUNDS; round++) {
      storyboard = await this.scripter.draft({
        pillar,
        articles: enriched,
        previousStoryboard: storyboard,
        editorFeedback:     lastVerdict?.feedback,
        round,
      });
      storyboard.revisionRound = round;

      lastVerdict = await this.editor.review(storyboard, articles);
      console.log(`[VDP] pillar=${pillar} round=${round} verdict=${lastVerdict.severity}`);

      if (lastVerdict.approved) return storyboard;

      // Minor issues are fixable but non-blocking — pass after last revision round
      if (lastVerdict.severity === 'minor' && round === MAX_ROUNDS - 1) {
        console.log(`[VDP] pillar=${pillar} minor issues remain after ${MAX_ROUNDS} rounds — proceeding`);
        return storyboard;
      }

      if (lastVerdict.severity === 'block') {
        throw new Error(`Editor blocked (brand safety): ${lastVerdict.feedback}`);
      }
    }

    throw new Error(
      `Editor rejected after ${MAX_ROUNDS} rounds. Last feedback: ${lastVerdict?.feedback}`
    );
  }

  private validateAudioDurations(audio: import('./types').AudioSegment[]): void {
    for (const seg of audio) {
      // Outro segment (index 3) is pre-rendered branded asset — skip duration validation
      if (seg.segmentIndex === 3) continue;
      if (seg.measuredDurationMs < 3000 || seg.measuredDurationMs > 10000) {
        throw new Error(
          `[VDP] Segment ${seg.segmentIndex} audio duration ${seg.measuredDurationMs}ms is outside [3000, 10000]ms — Editor must revise scriptLine`
        );
      }
    }
  }
}
