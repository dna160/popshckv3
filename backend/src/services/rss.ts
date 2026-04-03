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
  sourceFeed: string; // hostname of the feed URL this item came from
}

/**
 * ── Tier 2: Preferred — General Feeds (Round 1 / Broad Scrape) ───────────────
 *
 * Fetched on every Round 1 dispatch. Mixed-topic, high-volume Japanese
 * pop-culture feeds. The Scout's LLM triage categorises each item into the
 * correct pillar. These feeds organically cover all 5 pillars but are not
 * specialised — they are the starting "broad net".
 */
export const PRIORITY_FEEDS: string[] = [
  'https://automaton-media.com/feed/',                // Automaton               [gaming] [anime] [manga]
  'https://www.4gamer.net/rss/index.xml',             // 4Gamer                  [gaming]
  'https://hobby.dengeki.com/feed/',                  // Dengeki Hobby           [toys] [anime]
  'https://chaosphere.hostdon.jp/@natalie.rss',       // Natalie (Mastodon)      [anime] [manga] [gaming] [infotainment]
  'https://news.denfaminicogamer.jp/feed',            // Denfami                 [gaming] [anime] [manga]
  'https://essential-japan.com/feed/',                // Essential Japan         [infotainment]
  'https://www.toy-people.com/rss.php',               // Toy People News         [toys]
];

/**
 * ── Tier 1: Priority — Subpillar Branch Feeds (Underquota Protocol) ──────────
 *
 * Activated ONLY when the Master Orchestrator detects a quota deficit after
 * Round 1. The Scout switches from the broad net to a "sniper" approach,
 * fetching exclusively from hyper-specific feeds that match the missing pillars.
 *
 * Rules:
 *   - Only feeds for the missing_pillars are fetched; others are ignored.
 *   - LLM triage strictly filters results to the target pillar(s) only.
 *   - Pool size: 50 items (RETRY_POOL_SIZE) per dispatch.
 *
 * Tier 3 (fallback_protocol) re-uses these same feeds but sweeps ALL pillars,
 * sorted by FeedMemory score, when both Round 1 and Underquota have failed.
 *
 * Feed sources match the README Content Pillars table (source of truth).
 */
export const RSS_FEEDS: Record<Pillar, string[]> = {
  anime: [
    'https://chaosphere.hostdon.jp/@natalie.rss',       // Natalie (Mastodon proxy) [anime] [manga] [gaming] [infotainment]
  ],
  gaming: [
    'https://automaton-media.com/feed/',                // Automaton               [gaming] [anime] [manga]
    'https://www.4gamer.net/rss/index.xml',             // 4Gamer                  [gaming]
    'https://news.denfaminicogamer.jp/feed',             // Denfami                 [gaming] [anime] [manga]
  ],
  infotainment: [
    'https://essential-japan.com/feed/',                // Essential Japan         [infotainment]
    'https://chaosphere.hostdon.jp/@natalie.rss',       // Natalie (Mastodon proxy) [infotainment] [anime] [manga]
  ],
  manga: [
    'https://automaton-media.com/feed/',                // Automaton               [gaming] [anime] [manga]
    'https://chaosphere.hostdon.jp/@natalie.rss',       // Natalie (Mastodon proxy) [anime] [manga]
    'https://news.denfaminicogamer.jp/feed',             // Denfami                 [gaming] [anime] [manga]
  ],
  toys: [
    'https://hobby.dengeki.com/feed/',                  // Dengeki Hobby           [toys] [anime]
    'https://www.toy-people.com/rss.php',               // Toy People News         [toys]
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
  let sourceFeed = url;
  try { sourceFeed = new URL(url).hostname; } catch { /* keep raw url */ }

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
          return { title, link, summary: title, pubDate: item.pubDate, pillar, sourceFeed };
        }

        if (!item.title) return null;
        return {
          title: item.title.trim(),
          link: rawLink,
          summary: item.contentSnippet || item.summary || item.content || '',
          pubDate: item.pubDate,
          pillar,
          sourceFeed,
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null && item.title.length > 0 && item.link.length > 0) as RssItem[];
  } catch (err) {
    console.warn(`[RSS] Failed to fetch ${url}:`, (err as Error).message);
    return [];
  }
}

/**
 * Fetch the Tier 1 (Priority / Subpillar) feeds for a given pillar.
 * Uses RSS_FEEDS[pillar] — the hyper-specific subpillar branches, NOT the
 * general PRIORITY_FEEDS (Tier 2). Called during Underquota Protocol.
 */
export async function fetchPillarFeeds(pillar: Pillar): Promise<RssItem[]> {
  const feedUrls = RSS_FEEDS[pillar] ?? [];
  const results  = await Promise.allSettled(
    feedUrls.map((url) => fetchFeed(url, pillar))
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
