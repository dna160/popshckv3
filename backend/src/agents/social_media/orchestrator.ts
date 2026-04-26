/**
 * Social Media Orchestrator
 *
 * Manages the 4-agent post-publication social media pipeline for a single article.
 * Called fire-and-forget from the Master Orchestrator after an article reaches
 * the PUBLISHED state.
 *
 * Pipeline:
 *   1. HookCopywriter   → image_copy (5-6 words) + caption
 *   2. FrameGenerator   → Post buffer (1:1) + Story buffer (9:16)
 *   3. AdversarialEditor → PASS / FAIL with targeted feedback
 *      └─ On FAIL: feed back to copywriter and/or frame generator, retry (max 3×)
 *   4. Upload images to WordPress media library (get public URLs)
 *   5. SocialPublisher  → IG, FB, X, TikTok
 *   6. Persist SocialPost record to DB
 */

import { PrismaClient } from '@prisma/client';
import { HookCopywriter, HookCopywriterOutput } from './hook_copywriter/index';
import { FrameGenerator } from './frame_generator/index';
import { AdversarialEditor } from './adversarial_editor/index';
import { SocialPublisher } from './publisher/index';
import { uploadImageBuffer } from '../publisher/tools/wp_api_client';

const MAX_SOCIAL_LOOPS = 3;

export class SocialMediaOrchestrator {
  private prisma:    PrismaClient;
  private log:       (msg: string) => void;

  private copywriter: HookCopywriter;
  private frameGen:   FrameGenerator;
  private editor:     AdversarialEditor;
  private publisher:  SocialPublisher;

  constructor(prisma: PrismaClient, log: (msg: string) => void = console.log) {
    this.prisma    = prisma;
    this.log       = log;

    this.copywriter = new HookCopywriter((msg) => this.log(msg));
    this.frameGen   = new FrameGenerator((msg) => this.log(msg));
    this.editor     = new AdversarialEditor((msg) => this.log(msg));
    this.publisher  = new SocialPublisher((msg) => this.log(msg));
  }

  /**
   * Run the full social media pipeline for one published article.
   * This method is designed to be called fire-and-forget — it catches and
   * logs all errors internally so the main pipeline is never blocked.
   */
  async runForArticle(params: {
    articleId:        string;
    pillar:           string;
    featuredImageUrl: string;
    wpPostUrl:        string;
  }): Promise<void> {
    const { articleId, pillar, featuredImageUrl, wpPostUrl } = params;

    this.log(`[SocialOrchestrator] Starting pipeline for article ${articleId} (${pillar})`);

    // ── Fetch article markdown from DB ────────────────────────────────────────
    let articleMarkdown = '';
    try {
      const article = await this.prisma.article.findUnique({ where: { id: articleId } });
      articleMarkdown = article?.content ?? '';
      if (!articleMarkdown) {
        this.log(`[SocialOrchestrator] ⚠ No markdown content found for article ${articleId} — using title only`);
        articleMarkdown = article?.title ?? 'Article content unavailable.';
      }
    } catch (err) {
      this.log(`[SocialOrchestrator] ✗ Failed to fetch article: ${(err as Error).message}`);
      return;
    }

    // ── Adversarial loop ──────────────────────────────────────────────────────
    let copywriterOutput: HookCopywriterOutput | null = null;
    let frameOutput:      { postBuffer: Buffer; storyBuffer: Buffer } | null = null;
    let copywriterFeedback: string | undefined;
    let frameFeedback:      string | undefined;

    for (let loop = 0; loop < MAX_SOCIAL_LOOPS; loop++) {
      this.log(`[SocialOrchestrator] Loop ${loop + 1}/${MAX_SOCIAL_LOOPS}`);

      try {
        // Step 1: Hook Copywriter
        copywriterOutput = await this.copywriter.generate({
          articleMarkdown,
          pillar,
          feedback: copywriterFeedback,
        });
      } catch (err) {
        this.log(`[SocialOrchestrator] ✗ HookCopywriter failed: ${(err as Error).message}`);
        return;
      }

      try {
        // Step 2: Frame Generator
        frameOutput = await this.frameGen.generate({
          featuredImageUrl,
          imageCopy: copywriterOutput.image_copy,
          pillar,
          feedback:  frameFeedback,
        });
      } catch (err) {
        this.log(`[SocialOrchestrator] ✗ FrameGenerator failed: ${(err as Error).message}`);
        return;
      }

      // Step 3: Adversarial Editor
      let verdict;
      try {
        verdict = await this.editor.review({
          postImageBuffer:  frameOutput.postBuffer,
          storyImageBuffer: frameOutput.storyBuffer,
          caption:          copywriterOutput.caption,
          imageCopy:        copywriterOutput.image_copy,
        });
      } catch (err) {
        this.log(`[SocialOrchestrator] ⚠ AdversarialEditor threw — proceeding with current output: ${(err as Error).message}`);
        break; // Don't block on editor errors
      }

      if (verdict.verdict === 'PASS') {
        this.log(`[SocialOrchestrator] Editor PASS on loop ${loop + 1}`);
        break;
      }

      if (loop < MAX_SOCIAL_LOOPS - 1) {
        this.log(`[SocialOrchestrator] Editor FAIL — queuing retry ${loop + 2}/${MAX_SOCIAL_LOOPS}`);
        copywriterFeedback = verdict.feedback_for_copywriter      ?? undefined;
        frameFeedback      = verdict.feedback_for_frame_generator ?? undefined;
      } else {
        this.log(`[SocialOrchestrator] Editor FAIL on final loop — publishing best-effort output`);
      }
    }

    if (!copywriterOutput || !frameOutput) {
      this.log(`[SocialOrchestrator] ✗ Pipeline produced no output — aborting`);
      return;
    }

    // ── Upload rendered images to WordPress media ─────────────────────────────
    let postImageUrl:  string | undefined;
    let storyImageUrl: string | undefined;

    try {
      this.log(`[SocialOrchestrator] Uploading images to WordPress media…`);
      const [postMedia, storyMedia] = await Promise.all([
        uploadImageBuffer(
          frameOutput.postBuffer,
          `social-post-${articleId}-${Date.now()}.png`,
          copywriterOutput.image_copy,
          'image/png'
        ),
        uploadImageBuffer(
          frameOutput.storyBuffer,
          `social-story-${articleId}-${Date.now()}.png`,
          copywriterOutput.image_copy,
          'image/png'
        ),
      ]);
      postImageUrl  = postMedia.source_url;
      storyImageUrl = storyMedia.source_url;
      this.log(`[SocialOrchestrator] ✓ Post image: ${postImageUrl}`);
      this.log(`[SocialOrchestrator] ✓ Story image: ${storyImageUrl}`);
    } catch (err) {
      this.log(`[SocialOrchestrator] ✗ WordPress upload failed: ${(err as Error).message} — aborting`);
      await this.saveSocialPost({
        articleId,
        pillar,
        imageCopy:   copywriterOutput.image_copy,
        caption:     copywriterOutput.caption,
        status:      'FAILED',
      });
      return;
    }

    // ── Publish to social platforms ───────────────────────────────────────────
    let socialResult: Awaited<ReturnType<SocialPublisher['publish']>> = {};

    try {
      socialResult = await this.publisher.publish({
        postBuffer:    frameOutput.postBuffer,
        storyBuffer:   frameOutput.storyBuffer,
        postImageUrl,
        storyImageUrl,
        caption:       copywriterOutput.caption,
        articleUrl:    wpPostUrl,
      });
    } catch (err) {
      this.log(`[SocialOrchestrator] ✗ Publisher threw unexpectedly: ${(err as Error).message}`);
    }

    // ── Persist SocialPost record ─────────────────────────────────────────────
    const anyPosted = Object.values(socialResult).some(Boolean);
    await this.saveSocialPost({
      articleId,
      pillar,
      imageCopy:     copywriterOutput.image_copy,
      caption:       copywriterOutput.caption,
      postImageUrl,
      storyImageUrl,
      status:        anyPosted ? 'POSTED' : 'FAILED',
      postedAt:      anyPosted ? new Date() : undefined,
      igPostId:  socialResult.igPostId,
      igStoryId: socialResult.igStoryId,
      fbPostId:  socialResult.fbPostId,
      xPostId:   socialResult.xPostId,
    });

    this.log(
      `[SocialOrchestrator] ✓ Done for article ${articleId} — ` +
      `IG feed:${!!socialResult.igPostId} IG story:${!!socialResult.igStoryId} ` +
      `FB:${!!socialResult.fbPostId} X:${!!socialResult.xPostId}`
    );
  }

  // ── DB helper ───────────────────────────────────────────────────────────────

  private async saveSocialPost(params: {
    articleId:     string;
    pillar:        string;
    imageCopy:     string;
    caption:       string;
    postImageUrl?: string;
    storyImageUrl?: string;
    status:        string;
    postedAt?:     Date;
    igPostId?:  string;
    igStoryId?: string;
    fbPostId?:  string;
    xPostId?:   string;
  }): Promise<void> {
    try {
      await this.prisma.socialPost.create({ data: params });
      this.log(`[SocialOrchestrator] SocialPost record saved (status: ${params.status})`);
    } catch (err) {
      this.log(`[SocialOrchestrator] ⚠ Failed to save SocialPost record: ${(err as Error).message}`);
    }
  }
}
