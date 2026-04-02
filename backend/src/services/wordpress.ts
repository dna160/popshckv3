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
 * Returns the WordPress media ID and URL.
 */
export async function uploadImageFromUrl(
  imageUrl: string,
  altText: string
): Promise<WpMediaResponse> {
  const apiBase = getApiBase();
  const auth = getAuthHeader();

  // First, download the image
  const imgResponse = await fetch(imageUrl);
  if (!imgResponse.ok) {
    throw new Error(`Failed to download image from ${imageUrl}: ${imgResponse.status}`);
  }

  const imageBuffer = await imgResponse.arrayBuffer();
  const contentType = imgResponse.headers.get('content-type') || 'image/jpeg';
  const ext = contentType.includes('png') ? 'png' : 'jpg';
  const filename = `article-image-${Date.now()}.${ext}`;

  const uploadResponse = await fetch(`${apiBase}/media`, {
    method: 'POST',
    headers: {
      Authorization: auth,
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Type': contentType,
      'alt-text': altText,
    },
    body: imageBuffer,
  });

  if (!uploadResponse.ok) {
    const text = await uploadResponse.text();
    throw new Error(`WordPress media upload failed: ${uploadResponse.status} - ${text}`);
  }

  return (await uploadResponse.json()) as WpMediaResponse;
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
      if (img.isFeatured) {
        featuredMediaId = media.id;
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

  const post = await createPost({
    title,
    content: finalHtml,
    status: 'publish',
    featured_media: featuredMediaId,
    ...(categoryId !== undefined ? { categories: [categoryId] } : {}),
  });

  return {
    wpPostId: post.id,
    wpPostUrl: post.link,
  };
}
