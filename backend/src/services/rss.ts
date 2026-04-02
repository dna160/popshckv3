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
 * Priority Japanese RSS feeds.
 * These are fetched for ALL pillars — the Scout's LLM triage assigns each
 * item to the correct pillar based on content relevance.
 */
export const PRIORITY_FEEDS: string[] = [
  'https://automaton-media.com/feed/',                // Automaton — gaming, anime, manga (replaces dead Famitsu)
  'https://www.4gamer.net/rss/index.xml',             // 4Gamer — gaming
  'https://hobby.dengeki.com/feed/',                  // Dengeki Hobby — toys/collectibles
  'https://chaosphere.hostdon.jp/@natalie.rss',       // Natalie (Mastodon proxy) — anime, manga, infotainment
  'https://news.denfaminicogamer.jp/feed',            // Denfami — gaming, manga, anime (replaces empty Mantan)
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
/**
 * For Mastodon-proxy feeds (e.g. Natalie via chaosphere.hostdon.jp),
 * items have no <title>. Extract a title and the real article URL from
 * the HTML description instead.
 */
function extractFromMastodonDescription(
  html: string,
  fallbackLink: string
): { title: string; link: string } {
  // Strip HTML tags
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  // Remove leading 【 #tag #tag 】 section
  const cleaned = text.replace(/^【[^】]*】\s*/, '').trim();
  // Find the first real article URL embedded in an <a href>
  const urlMatch = html.match(/href="(https?:\/\/(?!chaosphere)[^"]+)"/);
  const articleLink = urlMatch ? urlMatch[1] : fallbackLink;
  // Title is everything before the URL at the end of the cleaned text
  const title = cleaned.replace(/https?:\/\/\S+/g, '').trim() || cleaned.slice(0, 120);
  return { title, link: articleLink };
}

export async function fetchFeed(url: string, pillar: Pillar): Promise<RssItem[]> {
  try {
    const feed = await parser.parseURL(url);
    const isMastodonFeed = url.includes('hostdon.jp') || url.includes('mastodon');

    return (feed.items || [])
      .filter((item) => item.link || item.guid)
      .map((item) => {
        const rawLink = (item.link || item.guid || '').trim();

        // Mastodon-proxy items lack <title> — extract from description HTML
        if (isMastodonFeed && !item.title) {
          const html = item.content || item.summary || item['content:encoded'] || '';
          const { title, link } = extractFromMastodonDescription(html, rawLink);
          return {
            title,
            link,
            summary: title,
            pubDate: item.pubDate,
            pillar,
          };
        }

        if (!item.title) return null;
        return {
          title: item.title.trim(),
          link: rawLink,
          summary: item.contentSnippet || item.summary || item.content || '',
          pubDate: item.pubDate,
          pillar,
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null && item.title.length > 0 && item.link.length > 0) as RssItem[];
  } catch (err) {
    console.warn(`[RSS] Failed to fetch ${url}:`, (err as Error).message);
    return [];
  }
}

/**
 * Fetch all feeds for a given pillar.
 * Only the priority Japanese feeds are used — no fallbacks.
 * The Scout's LLM triage filters items to the correct pillar.
 */
export async function fetchPillarFeeds(pillar: Pillar): Promise<RssItem[]> {
  const results = await Promise.allSettled(
    PRIORITY_FEEDS.map((url) => fetchFeed(url, pillar))
  );

  const allItems: RssItem[] = [];
  const seenLinks = new Set<string>();

  for (const result of results) {
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
