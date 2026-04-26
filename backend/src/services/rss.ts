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

/**
 * A feed entry with explicit pillar affinity tags, confidence rating, and
 * optional fallback URL.
 *
 * Tags reflect the pillars this feed PREDOMINANTLY covers based on actual
 * historical output (feed-memory.json), not just the publication's stated
 * coverage. If a feed claims to cover infotainment but FeedMemory shows zero
 * infotainment items in 30+ samples, the infotainment tag is removed.
 *
 * Confidence levels:
 *   • 'high'       — proven feed: ≥30 historical items, consistently produces
 *                    items for its tagged pillars. Underquota Protocol drains
 *                    these first.
 *   • 'medium'     — proven feed: 5–29 historical items, lower volume but
 *                    reliable.
 *   • 'low'        — proven but rare-yield: <5 historical items.
 *   • 'unverified' — configured but never recorded items in FeedMemory.
 *                    Either the URL is broken, the LLM rejects all items, or
 *                    items get attributed to a Mastodon proxy. Drained LAST
 *                    so verified sources are exhausted first.
 */
export interface FeedConfig {
  url:        string;
  tags:       Pillar[];
  confidence: 'high' | 'medium' | 'low' | 'unverified';
  fallback?:  string;
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
 *
 * e.g. natalie.mu/comic → tagged ['manga'] → activated when manga is underquota
 */
export const PRIORITY_FEEDS: FeedConfig[] = [
  // ─────────────────────────────────────────────────────────────────────────
  //   HIGH CONFIDENCE — Japanese RSS sources with proven historical output.
  //   Tags reflect ACTUAL pillar distribution in FeedMemory, NOT the
  //   publication's stated coverage. Sorted by total historical volume.
  // ─────────────────────────────────────────────────────────────────────────

  // ANN — 747 items: anime 69%, manga 16%, gaming 12%, toys 2%, info 1%.
  // English-language but covers Japanese content end-to-end. Single most
  // productive source overall.
  {
    url: 'https://www.animenewsnetwork.com/all/rss.xml?ann-edition=us',
    tags: ['anime', 'manga', 'gaming', 'toys'],
    confidence: 'high',
  },

  // 4Gamer — 227 items: gaming 92%, toys 5%, anime 3%. Pure gaming with
  // occasional figure/merch reviews tagged toys.
  {
    url:        'https://www.4gamer.net/rss/index.xml',
    tags:       ['gaming', 'toys'],
    confidence: 'high',
  },

  // Denfaminicogamer — 212 items: gaming 64%, anime 13%, toys 11%, manga 7%,
  // info 5%. The most pillar-diverse source we have.
  {
    url:        'https://news.denfaminicogamer.jp/feed',
    tags:       ['gaming', 'anime', 'toys', 'manga', 'infotainment'],
    confidence: 'high',
  },

  // Automaton — 115 items: gaming 100%. Pure gaming despite formerly being
  // tagged for anime/manga; the LLM never classifies its output as those.
  {
    url:        'https://automaton-media.com/feed/',
    tags:       ['gaming'],
    confidence: 'high',
  },

  // Chaosphere (Natalie Mastodon proxy) — 71 items: manga 65%, anime 30%,
  // info 4%, toys 1%. Aggregates natalie.mu's manga/anime verticals via
  // Mastodon since the direct natalie.mu/comic|anime feeds don't surface
  // any items in our memory.
  {
    url:        'https://chaosphere.hostdon.jp/@natalie.rss',
    tags:       ['manga', 'anime', 'infotainment'],
    confidence: 'high',
  },

  // Dengeki Hobby — 44 items: toys 82%, manga 9%, gaming 5%, anime 2%,
  // info 2%. Reliable toys/figures source. Dropped 'anime' tag (only 1 item).
  {
    url:        'https://hobby.dengeki.com/feed/',
    tags:       ['toys', 'manga'],
    confidence: 'high',
  },

  // Essential Japan — 34 items: gaming 56%, anime 35%, manga 9%.
  // ⚠️ HISTORICAL TAG WAS WRONG: previously tagged ['infotainment'] but
  // memory shows ZERO infotainment classifications. Retagged to actual output.
  {
    url:        'https://essential-japan.com/feed/',
    tags:       ['gaming', 'anime', 'manga'],
    confidence: 'medium',
  },

  // ─────────────────────────────────────────────────────────────────────────
  //   MASTODON PROXIES — Japanese publication aggregators served via
  //   rss-mstdn.studiofreesia.com.  These URLs were ALREADY in the codebase
  //   as fallbacks for the now-dead natalie.mu/* and oricon.co.jp/* primary
  //   URLs (every primary returned 404/403/410 in the live diagnostic).
  //   Promoting them to primaries makes the config honest — the system was
  //   already silently using these every run.
  //
  //   Each proxy aggregates a DIFFERENT Japanese publication:
  //     @animeanime — animeanime.jp (anime news + glossy/figure crossovers)
  //     @gamespark  — gamespark.jp  (gaming news, JP indie & gacha coverage)
  //     @oricon_news — oricon.co.jp (J-pop, idols, drama, films, charts)
  //
  //   They have 0 entries in feed-memory.json because past pipeline runs
  //   either couldn't reach them or attributed items elsewhere.  Marked
  //   'unverified' until first run produces measurable LLM-approved output.
  // ─────────────────────────────────────────────────────────────────────────

  // Anime — animeanime.jp aggregator.  Returns 20 items per fetch with
  // current pubDates.  Anime news, voice-actor coverage, figure/glossy crossovers.
  {
    url:        'https://rss-mstdn.studiofreesia.com/@animeanime.rss',
    tags:       ['anime', 'toys'],
    confidence: 'unverified',
  },

  // Gaming — gamespark.jp aggregator.  Returns 20 items per fetch.  Western
  // gaming + JP gacha/MMO coverage.  Gaming bucket usually doesn't need help,
  // but kept for completeness.
  {
    url:        'https://rss-mstdn.studiofreesia.com/@gamespark.rss',
    tags:       ['gaming'],
    confidence: 'unverified',
  },

  // Infotainment — oricon.co.jp aggregator.  THE primary structural answer
  // for the infotainment pillar.  All 4 dead oricon.co.jp/rss/* entries used
  // to fall back to this same URL (massive redundancy — fetched the same 20
  // items 4× per run).  Now consolidated into one entry.
  {
    url:        'https://rss-mstdn.studiofreesia.com/@oricon_news.rss',
    tags:       ['infotainment'],
    confidence: 'unverified',
  },

  // ─────────────────────────────────────────────────────────────────────────
  //   REMOVED FEEDS (logged here for archeology — see commit history):
  //
  //   • natalie.mu/comic/feed  — primary 404, fallback redundant with
  //                              chaosphere (which already aggregates
  //                              natalie.mu/comic content)
  //   • natalie.mu/anime/feed  — primary 404, fallback promoted above
  //   • natalie.mu/game/feed   — primary 404, fallback promoted above
  //   • natalie.mu/music/feed  — primary 404, fallback promoted above
  //   • oricon.co.jp/rss/news/    — primary 403, fallback consolidated above
  //   • oricon.co.jp/rss/music/   — primary 410 GONE, fallback consolidated
  //   • oricon.co.jp/rss/movie/   — primary 410 GONE, fallback consolidated
  //   • oricon.co.jp/rss/special/ — primary 410 GONE, fallback consolidated
  //   • feeds.feedburner.com/tokyohive — broken XML (unescaped & at line 70),
  //                                       no fallback, parser fails outright
  //   • amiami.com/eng/rss/newitem.xml — primary 403, fallback was
  //                                       hobby.dengeki.com (already a primary)
  //   • toy-people.com/rss.php — primary 404, fallback was hobby.dengeki.com
  //                              (already a primary, pure redundancy)
  // ─────────────────────────────────────────────────────────────────────────
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
    'https://chaosphere.hostdon.jp/@natalie.rss',                        // Natalie via Mastodon proxy — manga 65%, anime 30%
    'https://www.animenewsnetwork.com/all/rss.xml?ann-edition=us',       // ANN — anime 69%
    'https://rss-mstdn.studiofreesia.com/@animeanime.rss',               // animeanime.jp via Mastodon proxy
  ],
  gaming: [
    'https://www.4gamer.net/rss/index.xml',                              // 4Gamer — gaming 92%
    'https://automaton-media.com/feed/',                                  // Automaton — gaming 100%
    'https://news.denfaminicogamer.jp/feed',                              // Denfami — gaming 64% (most diverse)
    'https://rss-mstdn.studiofreesia.com/@gamespark.rss',                 // gamespark.jp via Mastodon proxy
  ],
  infotainment: [
    'https://rss-mstdn.studiofreesia.com/@oricon_news.rss',               // oricon.co.jp via Mastodon proxy — primary infotainment source
    'https://news.denfaminicogamer.jp/feed',                              // Denfami — info 5% (still measurable)
    'https://chaosphere.hostdon.jp/@natalie.rss',                        // Natalie — info 4%
  ],
  manga: [
    'https://chaosphere.hostdon.jp/@natalie.rss',                        // Natalie — manga 65% (best manga source)
    'https://www.animenewsnetwork.com/all/rss.xml?ann-edition=us',       // ANN — manga 16%
    'https://hobby.dengeki.com/feed/',                                    // Dengeki Hobby — manga 9%
    'https://news.denfaminicogamer.jp/feed',                              // Denfami — manga 7%
  ],
  toys: [
    'https://hobby.dengeki.com/feed/',                                    // Dengeki Hobby — toys 82% (best toys source)
    'https://www.4gamer.net/rss/index.xml',                              // 4Gamer — toys 5% (game merch)
    'https://news.denfaminicogamer.jp/feed',                              // Denfami — toys 11%
    'https://rss-mstdn.studiofreesia.com/@animeanime.rss',               // animeanime.jp via proxy — figure crossovers
  ],
};

/**
 * Lookup map: primary feed URL → fallback URL.
 * Built automatically from PRIORITY_FEEDS so callers don't have to scan the array.
 */
export const FEED_FALLBACK_MAP: ReadonlyMap<string, string> = new Map(
  PRIORITY_FEEDS
    .filter((f): f is FeedConfig & { fallback: string } => Boolean(f.fallback))
    .map((f) => [f.url, f.fallback])
);

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

function isMastodonUrl(url: string): boolean {
  return url.includes('hostdon.jp') || url.includes('mastodon') || url.includes('studiofreesia.com');
}

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
  // Find the first real article URL embedded in an <a href> (exclude proxy domains)
  const urlMatch = html.match(/href="(https?:\/\/(?!chaosphere)(?!rss-mstdn)[^"]+)"/);
  const articleLink = urlMatch ? urlMatch[1] : fallbackLink;
  // Title is everything before the URL at the end of the cleaned text
  const title = cleaned.replace(/https?:\/\/\S+/g, '').trim() || cleaned.slice(0, 120);
  return { title, link: articleLink };
}

/**
 * Attempt to parse a single URL. Returns items on success, throws on failure.
 */
async function parseUrl(url: string, pillar: Pillar): Promise<RssItem[]> {
  let sourceFeed = url;
  try { sourceFeed = new URL(url).hostname; } catch { /* keep raw url */ }

  const feed = await parser.parseURL(url);
  const isMastodon = isMastodonUrl(url);

  return (feed.items || [])
    .filter((item) => item.link || item.guid)
    .map((item) => {
      const rawLink = (item.link || item.guid || '').trim();

      // Mastodon-proxy items lack <title> — extract from description HTML
      if (isMastodon && !item.title) {
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
}

/**
 * Fetch and parse a single RSS feed URL.
 * If the primary URL fails and a fallback is provided, the fallback is tried.
 * Returns array of RssItems (may be empty if both fail).
 */
export async function fetchFeed(url: string, pillar: Pillar, fallback?: string): Promise<RssItem[]> {
  try {
    return await parseUrl(url, pillar);
  } catch (err) {
    console.warn(`[RSS] Failed to fetch ${url}:`, (err as Error).message);

    if (fallback) {
      console.info(`[RSS] Trying fallback for ${url} → ${fallback}`);
      try {
        return await parseUrl(fallback, pillar);
      } catch (fbErr) {
        console.warn(`[RSS] Fallback also failed for ${fallback}:`, (fbErr as Error).message);
      }
    }

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
