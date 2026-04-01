import dotenv from 'dotenv';

dotenv.config();

const SERPER_API_KEY = process.env.SERPER_API_KEY;
const SERPER_BASE_URL = 'https://google.serper.dev';

export interface SerperImageResult {
  title: string;
  imageUrl: string;
  imageWidth: number;
  imageHeight: number;
  thumbnailUrl: string;
  source: string;
  link: string;
}

export interface SerperImageResponse {
  images: SerperImageResult[];
}

/**
 * Search for images using SERPER Google Search API.
 */
export async function searchImages(
  query: string,
  num: number = 10
): Promise<SerperImageResult[]> {
  if (!SERPER_API_KEY) {
    throw new Error('SERPER_API_KEY environment variable is required');
  }

  const response = await fetch(`${SERPER_BASE_URL}/images`, {
    method: 'POST',
    headers: {
      'X-API-KEY': SERPER_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      q: query,
      num,
      safe: 'active',
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`SERPER API error ${response.status}: ${text}`);
  }

  const data = (await response.json()) as SerperImageResponse;
  return data.images || [];
}

/**
 * Build a targeted image search query for an article topic and pillar.
 */
export function buildImageQuery(topic: string, pillar: string): string {
  const pillarTerms: Record<string, string> = {
    anime: 'anime Japanese',
    gaming: 'Japanese video game',
    infotainment: 'Japan news culture',
    manga: 'manga Japanese comic',
    toys: 'Japanese collectible figure',
  };

  const prefix = pillarTerms[pillar] || 'Japan';
  // Truncate topic to avoid overly long queries
  const shortTopic = topic.split(' ').slice(0, 6).join(' ');
  return `${prefix} ${shortTopic}`;
}
