import Parser from 'rss-parser';
import type { Pillar } from '../shared/types';

const parser = new Parser({
  timeout: 10000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (compatible; SyntheticNewsroom/1.0; +https://github.com/dna160/popshckv3)',
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

/** A feed entry with explicit pillar affinity tags. */
export interface FeedConfig {
  url:  string;
  tags: Pillar[]; // pillars this feed predominantly covers
}

/**
 * ── Tier 2: Preferred — General Feeds (Round 1 / Broad Scrape) ───────────────
 *
 * Fetched on every Round 1 dispatch. Mixed-topic, high-volume Japanese
 * pop-culture feeds. The Scout's LLM triage categorises each item into the
 * correct pillar. These feeds organically cover all 5 pillars but are not
 * specialised — they are the starting "broad net".
 *
 * ── Tier 1: Priority — Subpillar-Specific Feeds (Underquota Protocol) ─────────
 *
 * Entries with a single specific tag (e.g. tags: ['manga']) are subpillar
 * branches. The Underquota Protocol filters this list by tag to build a
 * targeted pool for exactly the deficit pillar(s).
 */
export const PRIORITY_FEEDS: FeedConfig[] = [
  // ── General / mixed-topic (Round 1 broad net) ──────────────────────────────
  { url: 'https://automaton-media.com/feed/',                                    tags: ['gaming', 'anime', 'manga']                },
  { url: 'https://www.4gamer.net/rss/index.xml',                                 tags: ['gaming']                                  },
  { url: 'https://hobby.dengeki.com/feed/',                                      tags: ['toys', 'anime']                           },
  { url: 'https://chaosphere.hostdon.jp/@natalie.rss',                           tags: ['anime', 'manga', 'gaming', 'infotainment'] },
  { url: 'https://news.denfaminicogamer.jp/feed',                                tags: ['gaming', 'anime', 'manga']                },
  { url: 'https://essential-japan.com/feed/',                                    tags: ['infotainment']                            },
  { url: 'https://www.animenewsnetwork.com/all/rss.xml?ann-edition=us',          tags: ['anime', 'manga']                          },

  // ── Subpillar-specific branches (Underquota Protocol — Tier 1) ─────────────
  // Manga
  { url: 'https://rss-mstdn.studiofreesia.com/@natalie_mu_comic.rss',            tags: ['manga']                                   },
  // Anime
  { url: 'https://rss-mstdn.studiofreesia.com/@animeanime.rss',                  tags: ['anime']                                   },
  // Gaming
  { url: 'https://rss-mstdn.studiofreesia.com/@gamespark.rss',                   tags: ['gaming']                                  },
  // Infotainment — Oricon news via Mastodon proxy (last confirmed active 2025-11)
  { url: 'https://rss-mstdn.studiofreesia.com/@oricon_news.rss',                 tags: ['infotainment']                            },
];

/**
 * ── Tier 1: Priority — Subpillar Branch Feeds (Underquota Protocol) ──────────
 *
 * Activated ONLY when the Master Orchestrator detects a quota deficit after
 * Round 1. The Scout switches from the broad net to a "sniper" approach,
 * fetching exclusively from hyper-specific feeds that match the missing pillars.
 */
export const RSS_FEEDS: Record<Pillar, string[]> = {
  anime: [
    'https://chaosphere.hostdon.jp/@natalie.rss',                         // Natalie (Mastodon proxy)
    'https://rss-mstdn.studiofreesia.com/@animeanime.rss',                // Anime!Anime! (Mastodon proxy)
    'https://www.animenewsnetwork.com/all/rss.xml?ann-edition=us',        // Anime News Network
  ],
  gaming: [
    'https://automaton-media.com/feed/',                                  // Automaton
    'https://www.4gamer.net/rss/index.xml',                               // 4Gamer
    'https://news.denfaminicogamer.jp/feed',                              // Denfami
    'https://rss-mstdn.studiofreesia.com/@gamespark.rss',                 // Game*Spark (Mastodon proxy)
  ],
  infotainment: [
    'https://essential-japan.com/feed/',                                  // Essential Japan
    'https://chaosphere.hostdon.jp/@natalie.rss',                         // Natalie (Mastodon proxy)
    'https://rss-mstdn.studiofreesia.com/@oricon_news.rss',               // Oricon News (Mastodon proxy)
  ],
  manga: [
    'https://automaton-media.com/feed/',                                  // Automaton
    'https://chaosphere.hostdon.jp/@natalie.rss',                         // Natalie (Mastodon proxy)
    'https://news.denfaminicogamer.jp/feed',                              // Denfami
    'https://rss-mstdn.studiofreesia.com/@natalie_mu_comic.rss',          // Comic Natalie (Mastodon proxy)
  ],
  toys: [
    'https://hobby.dengeki.com/feed/',                                    // Dengeki Hobby
  ],
};

/**
 * Fetch and parse a single RSS feed URL.
 * Returns array of RssItems (may be empty on failure).
 */
/**
 * For Mastodon-proxy feeds (e.g. Natalie via chaosphere.hostdon.jp or
 * rss-mstdn.studiofreesia.com), items have no <title>. Extract a title and
 * the real article URL from the HTML description instead.
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
  const urlMatch = html.match(/href="(https?:\/\/(?!chaosphere)(?!rss-mstdn)[^"]+)"/);
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
    const isMastodonFeed =
      url.includes('hostdon.jp') ||
      url.includes('mastodon') ||
      url.includes('studiofreesia.com');

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
