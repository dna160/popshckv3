import { uploadVideo } from './tools/wp_video_upload';
import {
  postReelToInstagram,
  postStoryVideoToInstagram,
} from '../social_media/publisher/tools/social_apis';
import type { ComposedVideo, PublishResult } from './types';

const IG_QUOTA_WARN_THRESHOLD = 95;

async function checkIgQuota(): Promise<number> {
  const token     = process.env.IG_ACCESS_TOKEN;
  const accountId = process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID;
  if (!token || !accountId) return 0;

  try {
    const res = await fetch(
      `https://graph.facebook.com/v22.0/${accountId}/content_publishing_limit` +
      `?fields=quota_usage,config&access_token=${token}`
    );
    if (!res.ok) return 0;
    const { data } = (await res.json()) as { data: Array<{ quota_usage: number }> };
    return data?.[0]?.quota_usage ?? 0;
  } catch {
    return 0;
  }
}

export class VideoPublisher {
  async publish(video: ComposedVideo): Promise<PublishResult> {
    const filename = `popshck-digest-${video.pillar}-${Date.now()}.mp4`;

    console.log(`[VideoPublisher] Uploading ${video.pillar} video to WordPress (${Math.round(video.mp4Buffer.length / 1024)}KB)`);
    const wpMediaUrl = await uploadVideo({ buffer: video.mp4Buffer, filename });
    console.log(`[VideoPublisher] WP URL: ${wpMediaUrl}`);

    const errors:  string[] = [];
    let reelId:  string | null = null;
    let storyId: string | null = null;

    // Check quota before publishing
    const quotaUsage = await checkIgQuota();
    if (quotaUsage >= IG_QUOTA_WARN_THRESHOLD) {
      const msg = `[VideoPublisher] IG quota at ${quotaUsage}/100 — skipping publish for ${video.pillar}`;
      console.warn(msg);
      errors.push(msg);
      return { wpMediaUrl, reelId, storyId, errors };
    }

    // Publish as Reel
    try {
      reelId = await postReelToInstagram({ videoUrl: wpMediaUrl, caption: video.caption });
      console.log(`[VideoPublisher] Reel published: ${reelId}`);
    } catch (err) {
      const msg = `Reel publish failed: ${(err as Error).message}`;
      console.error(`[VideoPublisher] ${msg}`);
      errors.push(msg);
    }

    // Publish as Story (independent — one can succeed while the other fails)
    try {
      storyId = await postStoryVideoToInstagram({ videoUrl: wpMediaUrl });
      console.log(`[VideoPublisher] Story published: ${storyId}`);
    } catch (err) {
      const msg = `Story publish failed: ${(err as Error).message}`;
      console.error(`[VideoPublisher] ${msg}`);
      errors.push(msg);
    }

    return { wpMediaUrl, reelId, storyId, errors };
  }
}
