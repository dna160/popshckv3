/**
 * Agent 4: Platform Publisher
 *
 * Receives the finalised images (as Buffers and WordPress media URLs) and caption,
 * then executes API calls to all four platforms concurrently.
 *
 * Strategy:
 *   Instagram Feed  → Post image (1:1) via public WP URL + caption
 *   Instagram Story → Story image (9:16) via public WP URL
 *   Facebook        → Post image (1:1) via public WP URL + caption
 *   X               → Story image buffer uploaded binary + caption + article link
 *   TikTok          → disabled
 *
 * Partial publish is acceptable — a single platform failure does not abort
 * the others. All results (success or failure) are logged and returned.
 */

import {
  postToInstagram,
  postStoryToInstagram,
  postToFacebook,
  postToX,
} from './tools/social_apis';

export interface SocialPublishResult {
  igPostId?:  string;
  igStoryId?: string;
  fbPostId?:  string;
  xPostId?:   string;
}

export class SocialPublisher {
  private log: (msg: string) => void;

  constructor(log: (msg: string) => void = console.log) {
    this.log = log;
  }

  async publish(params: {
    postBuffer:    Buffer;   // 1:1  — for IG + FB binary fallback
    storyBuffer:   Buffer;   // 9:16 — for X (binary) + TikTok (video)
    postImageUrl:  string;   // public WP URL of the 1:1 image (for IG + FB)
    storyImageUrl: string;   // public WP URL of the 9:16 image (unused but available)
    caption:       string;
    articleUrl:    string;
  }): Promise<SocialPublishResult> {
    const { storyBuffer, postImageUrl, storyImageUrl, caption, articleUrl } = params;

    this.log('[SocialPublisher] Dispatching to all platforms concurrently…');

    // ── Concurrent platform dispatch ─────────────────────────────────────────
    const [igFeedResult, igStoryResult, fbResult, xResult] = await Promise.allSettled([
      postToInstagram({ imageUrl: postImageUrl, caption }),
      postStoryToInstagram({ imageUrl: storyImageUrl }),
      postToFacebook({ imageUrl: postImageUrl, caption }),
      postToX({ imageBuffer: storyBuffer, caption, articleUrl }),
    ]);

    const result: SocialPublishResult = {};

    if (igFeedResult.status === 'fulfilled') {
      result.igPostId = igFeedResult.value;
      this.log(`[SocialPublisher] ✓ Instagram feed posted → ID: ${igFeedResult.value}`);
    } else {
      this.log(`[SocialPublisher] ✗ Instagram feed failed: ${igFeedResult.reason}`);
    }

    if (igStoryResult.status === 'fulfilled') {
      result.igStoryId = igStoryResult.value;
      this.log(`[SocialPublisher] ✓ Instagram story posted → ID: ${igStoryResult.value}`);
    } else {
      this.log(`[SocialPublisher] ✗ Instagram story failed: ${igStoryResult.reason}`);
    }

    if (fbResult.status === 'fulfilled') {
      result.fbPostId = fbResult.value;
      this.log(`[SocialPublisher] ✓ Facebook posted → ID: ${fbResult.value}`);
    } else {
      this.log(`[SocialPublisher] ✗ Facebook failed: ${fbResult.reason}`);
    }

    if (xResult.status === 'fulfilled') {
      result.xPostId = xResult.value;
      this.log(`[SocialPublisher] ✓ X (Twitter) posted → ID: ${xResult.value}`);
    } else {
      this.log(`[SocialPublisher] ✗ X (Twitter) failed: ${xResult.reason}`);
    }

    const successCount = Object.keys(result).length;
    this.log(`[SocialPublisher] Complete — ${successCount}/4 platforms attempted`);

    return result;
  }
}
