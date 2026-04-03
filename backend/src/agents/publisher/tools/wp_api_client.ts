/**
 * WordPress REST API Client (Publisher Agent Tool)
 *
 * Handles all WordPress REST API operations for the Publisher Agent:
 * - Image upload (binary POST + metadata PATCH for alt_text)
 * - Post creation with author ID and category assignment
 *
 * Author–WP User ID mapping (matches persona names from specialized copywriters):
 *   Satoshi → 2  (Anime)
 *   Hikari  → 7  (Gaming)       WP user: MRYAKUZA
 *   Kenji   → 9  (Infotainment) WP user: LISAKAGAWA
 *   Rina    → 5  (Manga)
 *   Taro    → 8  (Toys/Collectibles) WP user: FINALHERO
 */

import type { ArticleImage, Pillar } from '../../../../../shared/types';

// ── Author ID mapping ─────────────────────────────────────────────────────────
export const AUTHOR_IDS: Record<string, number> = {
  Satoshi: 2,
  Hikari:  7,  // WP user: MRYAKUZA
  Kenji:   9,  // WP user: LISAKAGAWA
  Rina:    5,
  Taro:    8,  // WP user: FINALHERO
};

// ── Category ID mapping ───────────────────────────────────────────────────────
export const CATEGORY_IDS: Record<Pillar, number> = {
  anime:         11,
  gaming:        13,
  infotainment:  10,
  manga:         14,
  toys:          12,
};

// ── Interfaces ────────────────────────────────────────────────────────────────
export interface WpPostPayload {
  title:           string;
  content:         string;
  status:          'publish' | 'draft' | 'pending';
  categories?:     number[];
  featured_media?: number;
  author?:         number;
}

export interface WpPostResponse {
  id:     number;
  link:   string;
  status: string;
  title:  { rendered: string };
}

export interface WpMediaResponse {
  id:         number;
  source_url: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function getConfig(): { apiBase: string; auth: string } {
  const baseUrl = (process.env.WP_BASE_URL || process.env.WP_URL)?.replace(/\/$/, '');
  const username = process.env.WP_USERNAME;
  const password = process.env.WP_APP_PASSWORD;

  if (!baseUrl)    throw new Error('WP_BASE_URL environment variable is required');
  if (!username || !password) throw new Error('WordPress credentials (WP_USERNAME, WP_APP_PASSWORD) are required');

  const credentials = Buffer.from(`${username}:${password}`).toString('base64');
  return {
    apiBase: `${baseUrl}/wp-json/wp/v2`,
    auth:    `Basic ${credentials}`,
  };
}

/**
 * Upload a remote image to the WordPress media library.
 * Step 1: POST binary to /media.
 * Step 2: POST /media/{id} to set alt_text (WP REST API ignores it during binary upload).
 */
export async function uploadImageFromUrl(
  imageUrl: string,
  altText:  string
): Promise<WpMediaResponse> {
  const { apiBase, auth } = getConfig();

  // Download source image
  const imgResponse = await fetch(imageUrl);
  if (!imgResponse.ok) {
    throw new Error(`Failed to download image from ${imageUrl}: ${imgResponse.status}`);
  }

  const imageBuffer  = await imgResponse.arrayBuffer();
  const contentType  = imgResponse.headers.get('content-type') || 'image/jpeg';
  const ext          = contentType.includes('png')  ? 'png'  :
                       contentType.includes('gif')  ? 'gif'  :
                       contentType.includes('webp') ? 'webp' : 'jpg';
  const filename     = `article-image-${Date.now()}.${ext}`;

  // Upload binary
  const uploadResponse = await fetch(`${apiBase}/media`, {
    method:  'POST',
    headers: {
      Authorization:        auth,
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Type':        contentType,
    },
    body: imageBuffer,
  });

  if (!uploadResponse.ok) {
    const text = await uploadResponse.text();
    throw new Error(`WordPress media upload failed: ${uploadResponse.status} - ${text}`);
  }

  const media = (await uploadResponse.json()) as WpMediaResponse;

  // Set alt_text via PATCH (POST in WP REST convention)
  try {
    const patchResponse = await fetch(`${apiBase}/media/${media.id}`, {
      method:  'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ alt_text: altText, title: altText }),
    });
    if (!patchResponse.ok) {
      console.warn(`[WpApiClient] Could not set alt_text for media ${media.id}: ${patchResponse.status}`);
    }
  } catch (err) {
    console.warn(`[WpApiClient] alt_text patch failed for media ${media.id}:`, (err as Error).message);
  }

  return media;
}

/**
 * Create a WordPress post.
 */
export async function createPost(payload: WpPostPayload): Promise<WpPostResponse> {
  const { apiBase, auth } = getConfig();

  const response = await fetch(`${apiBase}/posts`, {
    method:  'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`WordPress post creation failed: ${response.status} - ${text}`);
  }

  return (await response.json()) as WpPostResponse;
}

/**
 * Full publish flow: upload images, replace URLs in HTML, create post.
 * Returns WP post ID and live URL.
 */
export async function publishToWordPress(params: {
  title:       string;
  contentHtml: string;
  images:      ArticleImage[];
  pillar:      Pillar;
  authorName?: string;  // persona name → mapped to WP user ID
}): Promise<{ wpPostId: number; wpPostUrl: string }> {
  const { title, images, pillar, authorName } = params;

  let featuredMediaId: number | undefined;
  const uploadedImages: Array<{ originalUrl: string; wpUrl: string }> = [];

  // Upload all images
  for (const img of images) {
    try {
      const media = await uploadImageFromUrl(img.url, img.alt);
      uploadedImages.push({ originalUrl: img.url, wpUrl: media.source_url });
      if (img.isFeatured) {
        featuredMediaId = media.id;
      } else if (featuredMediaId === undefined) {
        featuredMediaId = media.id; // first-upload fallback
      }
    } catch (err) {
      console.warn(`[WpApiClient] Failed to upload image ${img.url}:`, (err as Error).message);
    }
  }

  // Replace original image URLs with WP-hosted URLs in the HTML
  let finalHtml = params.contentHtml;
  for (const uploaded of uploadedImages) {
    finalHtml = finalHtml.split(uploaded.originalUrl).join(uploaded.wpUrl);
  }

  const categoryId = CATEGORY_IDS[pillar];
  const authorId   = authorName ? AUTHOR_IDS[authorName] : undefined;

  const post = await createPost({
    title,
    content:         finalHtml,
    status:          'publish',
    featured_media:  featuredMediaId,
    categories:      [categoryId],
    ...(authorId !== undefined ? { author: authorId } : {}),
  });

  return { wpPostId: post.id, wpPostUrl: post.link };
}
