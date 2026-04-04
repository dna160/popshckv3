import dotenv from 'dotenv';
import type { ArticleImage, Pillar } from '../../../shared/types';

dotenv.config();

const WP_BASE_URL = (process.env.WP_BASE_URL || process.env.WP_URL)?.replace(/\/$/, '');
const WP_USERNAME = process.env.WP_USERNAME;
const WP_APP_PASSWORD = process.env.WP_APP_PASSWORD;

export interface WpPostPayload {
  title: string;
  content: string;       // HTML content
  status: 'publish' | 'draft' | 'pending';
  categories?: number[];
  tags?: number[];
  featured_media?: number;
  author?: number;
  meta?: Record<string, unknown>;
}

export interface WpPostResponse {
  id: number;
  link: string;
  status: string;
  title: { rendered: string };
}

export interface WpMediaResponse {
  id: number;
  source_url: string;
}

const wpCategoryMap: Record<Pillar, number> = {
  anime: 11,        // Anime
  gaming: 13,       // Game
  infotainment: 10, // Infotainment
  manga: 14,        // Comic (no dedicated Manga category)
  toys: 12,         // Toys
};

/**
 * Pillar → WordPress Author ID mapping.
 * Must stay in sync with AUTHOR_IDS in publisher/tools/wp_api_client.ts.
 *
 *   anime        → 2   (Satoshi)
 *   gaming       → 7   (Hikari    — WP user: MRYAKUZA)
 *   infotainment → 9   (Kenji     — WP user: LISAKAGAWA)
 *   manga        → 5   (Rina)
 *   toys         → 8   (Taro      — WP user: FINALHERO)
 */
const wpAuthorMap: Record<Pillar, number> = {
  anime:         2,
  gaming:        7,
  infotainment:  9,
  manga:         5,
  toys:          8,
};

function getAuthHeader(): string {
  if (!WP_USERNAME || !WP_APP_PASSWORD) {
    throw new Error('WordPress credentials (WP_USERNAME, WP_APP_PASSWORD) are required');
  }
  const credentials = Buffer.from(`${WP_USERNAME}:${WP_APP_PASSWORD}`).toString('base64');
  return `Basic ${credentials}`;
}

function getApiBase(): string {
  if (!WP_BASE_URL) {
    throw new Error('WP_BASE_URL environment variable is required');
  }
  return `${WP_BASE_URL}/wp-json/wp/v2`;
}

/**
 * Upload a remote image to WordPress media library by URL.
 * Step 1: POST the binary to /media (sets the file).
 * Step 2: PATCH /media/{id} to set alt_text and title (WP REST API
 *         does not accept these fields during binary upload).
 * Returns the WordPress media ID and URL.
 */
export async function uploadImageFromUrl(
  imageUrl: string,
  altText: string
): Promise<WpMediaResponse> {
  const apiBase = getApiBase();
  const auth = getAuthHeader();

  // ── Step 1: download the source image ───────────────────────────────────
  const imgResponse = await fetch(imageUrl);
  if (!imgResponse.ok) {
    throw new Error(`Failed to download image from ${imageUrl}: ${imgResponse.status}`);
  }

  const imageBuffer = await imgResponse.arrayBuffer();
  const contentType = imgResponse.headers.get('content-type') || 'image/jpeg';
  const ext = contentType.includes('png') ? 'png' :
               contentType.includes('gif') ? 'gif' :
               contentType.includes('webp') ? 'webp' : 'jpg';
  const filename = `article-image-${Date.now()}.${ext}`;

  // ── Step 2: upload binary to WP media library ────────────────────────────
  const uploadResponse = await fetch(`${apiBase}/media`, {
    method: 'POST',
    headers: {
      Authorization: auth,
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Type': contentType,
    },
    body: imageBuffer,
  });

  if (!uploadResponse.ok) {
    const text = await uploadResponse.text();
    throw new Error(`WordPress media upload failed: ${uploadResponse.status} - ${text}`);
  }

  const media = (await uploadResponse.json()) as WpMediaResponse;

  // ── Step 3: PATCH to set alt_text and title (binary upload ignores these) ─
  try {
    const patchResponse = await fetch(`${apiBase}/media/${media.id}`, {
      method: 'POST', // WP REST API uses POST (not PATCH) for updates
      headers: {
        Authorization: auth,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        alt_text: altText,
        title: altText,
      }),
    });
    if (!patchResponse.ok) {
      console.warn(`[WordPress] Could not set alt_text for media ${media.id}: ${patchResponse.status}`);
    }
  } catch (err) {
    console.warn(`[WordPress] alt_text patch failed for media ${media.id}:`, (err as Error).message);
  }

  return media;
}

/**
 * Create a WordPress post.
 */
export async function createPost(payload: WpPostPayload): Promise<WpPostResponse> {
  const apiBase = getApiBase();
  const auth = getAuthHeader();

  const response = await fetch(`${apiBase}/posts`, {
    method: 'POST',
    headers: {
      Authorization: auth,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`WordPress post creation failed: ${response.status} - ${text}`);
  }

  return (await response.json()) as WpPostResponse;
}

/**
 * Publish an article to WordPress.
 * Handles image uploads and sets featured image.
 * Returns the WP post ID and URL.
 */
export async function publishArticle(
  title: string,
  contentHtml: string,
  images: ArticleImage[],
  pillar?: Pillar
): Promise<{ wpPostId: number; wpPostUrl: string }> {
  if (!WP_BASE_URL) {
    throw new Error('WP_BASE_URL is not configured');
  }

  let featuredMediaId: number | undefined;
  const uploadedImages: Array<{ originalUrl: string; wpUrl: string; wpId: number }> = [];

  // Upload all images to WP media library
  for (const img of images) {
    try {
      const media = await uploadImageFromUrl(img.url, img.alt);
      uploadedImages.push({
        originalUrl: img.url,
        wpUrl: media.source_url,
        wpId: media.id,
      });
      // Mark as featured if flagged, or fall back to the first successfully uploaded image
      if (img.isFeatured) {
        featuredMediaId = media.id;
      } else if (featuredMediaId === undefined) {
        featuredMediaId = media.id; // first-upload fallback; overridden if a flagged image succeeds
      }
    } catch (err) {
      console.warn(`[WordPress] Failed to upload image ${img.url}:`, (err as Error).message);
    }
  }

  // Replace image URLs in HTML with WP media URLs
  let finalHtml = contentHtml;
  for (const uploaded of uploadedImages) {
    finalHtml = finalHtml.split(uploaded.originalUrl).join(uploaded.wpUrl);
  }

  const categoryId = pillar ? wpCategoryMap[pillar] : undefined;
  const authorId   = pillar ? wpAuthorMap[pillar]   : undefined;

  const post = await createPost({
    title,
    content: finalHtml,
    status: 'publish',
    featured_media: featuredMediaId,
    ...(categoryId !== undefined ? { categories: [categoryId] } : {}),
    ...(authorId   !== undefined ? { author: authorId }         : {}),
  });

  return {
    wpPostId: post.id,
    wpPostUrl: post.link,
  };
}
