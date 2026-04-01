import Parser from 'rss-parser';
import type { Pillar } from '../../../shared/types';

const parser = new Parser({
  timeout: 10000,
  headers: {
    'User-Agent': 'SyntheticNewsroom/1.0 RSS Reader',
  },
});

export interface RssItem {
  title: string;
  link: string;
  summary: string;
  pubDate?: string;
  pillar: Pillar;
}

/**
 * Priority Japanese RSS feeds as required by the PRD.
 * These are fetched for ALL pillars — the Scout's LLM triage assigns each
 * item to the correct pillar based on content relevance.
 */
export const PRIORITY_FEEDS: string[] = [
  'http://www.famitsu.com/rss/fcom_all.rdf',          // Famitsu — gaming, anime, manga
  'https://www.4gamer.net/rss/index.xml',             // 4Gamer — gaming
  'https://hobby.dengeki.com/feed/',                  // Dengeki Hobby — toys/collectibles
  'https://chaosphere.hostdon.jp/@natalie.rss',       // Natalie (Mastodon proxy) — anime, manga, infotainment
  'http://mantan-web.jp/index.rss',                   // Mantan Web — infotainment/entertainment
];

/**
 * Pillar-specific fallback feeds used only when priority feeds yield
 * insufficient candidates for a given pillar.
 */
export const RSS_FEEDS: Record<Pillar, string[]> = {
  anime: [
    'https://www.animenewsnetwork.com/all/rss.xml',
  ],
  gaming: [
    'https://www.siliconera.com/feed/',
  ],
  infotainment: [
    'https://soranews24.com/feed/',
  ],
  manga: [
    'https://animecorner.me/category/manga/feed/',
  ],
  toys: [
    'https://www.toyark.com/feed/',
  ],
};

/**
 * Fetch and parse a single RSS feed URL.
 * Returns array of RssItems (may be empty on failure).
 */
export async function fetchFeed(url: string, pillar: Pillar): Promise<RssItem[]> {
  try {
    const feed = await parser.parseURL(url);
    return (feed.items || [])
      .filter((item) => item.title && item.link)
      .map((item) => ({
        title: item.title!.trim(),
        link: item.link!.trim(),
        summary: item.contentSnippet || item.summary || item.content || '',
        pubDate: item.pubDate,
        pillar,
      }));
  } catch (err) {
    console.warn(`[RSS] Failed to fetch ${url}:`, (err as Error).message);
    return [];
  }
}

/**
 * Fetch all feeds for a given pillar.
 * Priority Japanese feeds are fetched first (shared across all pillars);
 * pillar-specific fallback feeds are appended afterward.
 * The Scout's LLM triage filters items to the correct pillar.
 */
export async function fetchPillarFeeds(pillar: Pillar): Promise<RssItem[]> {
  const priorityResults = await Promise.allSettled(
    PRIORITY_FEEDS.map((url) => fetchFeed(url, pillar))
  );
  const fallbackResults = await Promise.allSettled(
    RSS_FEEDS[pillar].map((url) => fetchFeed(url, pillar))
  );

  const allItems: RssItem[] = [];
  const seenLinks = new Set<string>();

  // Priority feeds first
  for (const result of [...priorityResults, ...fallbackResults]) {
    if (result.status === 'fulfilled') {
      for (const item of result.value) {
        if (!seenLinks.has(item.link)) {
          seenLinks.add(item.link);
          allItems.push(item);
        }
      }
    }
  }

  return allItems;
}

/**
 * Fetch all feeds for all pillars in parallel.
 */
export async function fetchAllFeeds(): Promise<Record<Pillar, RssItem[]>> {
  const pillars: Pillar[] = ['anime', 'gaming', 'infotainment', 'manga', 'toys'];

  const results = await Promise.allSettled(
    pillars.map((p) => fetchPillarFeeds(p).then((items) => ({ pillar: p, items })))
  );

  const output: Partial<Record<Pillar, RssItem[]>> = {};

  for (const result of results) {
    if (result.status === 'fulfilled') {
      output[result.value.pillar] = result.value.items;
    } else {
      // Fill with empty on failure — scout will handle quota
      console.warn('[RSS] Failed to fetch pillar feeds:', result.reason);
    }
  }

  // Ensure all pillars present
  for (const pillar of pillars) {
    if (!output[pillar]) {
      output[pillar] = [];
    }
  }

  return output as Record<Pillar, RssItem[]>;
}
