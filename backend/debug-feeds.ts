/**
 * Feed Diagnostic — probes every configured RSS feed (PRIORITY_FEEDS + fallbacks)
 * and reports status, item count, and a sample item per feed.
 *
 * Run from backend/:
 *   npx tsx debug-feeds.ts
 */

import { PRIORITY_FEEDS, fetchFeed }                    from './src/services/rss';
import path                                              from 'path';
import fs                                                from 'fs/promises';

interface Probe {
  url:          string;
  tags:         string[];
  confidence:   string;
  status:       'OK' | 'FAIL' | 'EMPTY' | 'FALLBACK_USED';
  itemCount:    number;
  primaryError?: string;
  sourceFeed?:  string;          // hostname recorded on returned items
  sample?:      string;          // first item title
  pubDateRange?: { newest: string; oldest: string };
  fallbackUrl?: string;
}

const MEMORY_FILE = path.join(process.cwd(), 'data', 'feed-memory.json');

async function loadMemory(): Promise<Record<string, Record<string, number>>> {
  try {
    return JSON.parse(await fs.readFile(MEMORY_FILE, 'utf-8'));
  } catch { return {}; }
}

async function probeFeed(feed: typeof PRIORITY_FEEDS[number]): Promise<Probe> {
  const probe: Probe = {
    url:        feed.url,
    tags:       feed.tags,
    confidence: feed.confidence,
    status:     'FAIL',
    itemCount:  0,
    fallbackUrl: feed.fallback,
  };

  // Attempt primary first; mirror fetchFeed's behaviour but capture which
  // URL actually succeeded so we can detect "fallback was used silently".
  const Parser = (await import('rss-parser')).default;
  const parser = new Parser({
    timeout: 15000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; SyntheticNewsroom/1.0; +https://github.com/dna160/popshckv3)',
    },
  });

  let items: any[] = [];
  let usedUrl: string = feed.url;

  try {
    const parsed = await parser.parseURL(feed.url);
    items = parsed.items || [];
  } catch (err) {
    probe.primaryError = (err as Error).message;

    if (feed.fallback) {
      try {
        const parsed = await parser.parseURL(feed.fallback);
        items = parsed.items || [];
        usedUrl = feed.fallback;
        probe.status = 'FALLBACK_USED';
      } catch (fbErr) {
        probe.primaryError = `primary: ${probe.primaryError} | fallback: ${(fbErr as Error).message}`;
        return probe;
      }
    } else {
      return probe;
    }
  }

  if (items.length === 0) {
    probe.status = probe.status === 'FALLBACK_USED' ? 'FALLBACK_USED' : 'EMPTY';
    probe.itemCount = 0;
    return probe;
  }

  probe.itemCount = items.length;
  if (probe.status !== 'FALLBACK_USED') probe.status = 'OK';

  try { probe.sourceFeed = new URL(usedUrl).hostname; } catch { probe.sourceFeed = usedUrl; }

  probe.sample = (items[0]?.title || items[0]?.contentSnippet || '(no title)').slice(0, 100);

  // Compute pubDate range
  const dates = items
    .map((i) => i.pubDate || i.isoDate)
    .filter(Boolean)
    .map((d) => new Date(d!).getTime())
    .filter((t) => !isNaN(t));

  if (dates.length > 0) {
    probe.pubDateRange = {
      newest: new Date(Math.max(...dates)).toISOString().slice(0, 10),
      oldest: new Date(Math.min(...dates)).toISOString().slice(0, 10),
    };
  }

  return probe;
}

async function main(): Promise<void> {
  console.log('\n╔══════════════════════════════════════════════════════════════════════════╗');
  console.log('║  RSS Feed Diagnostic — probing all configured PRIORITY_FEEDS              ║');
  console.log('╚══════════════════════════════════════════════════════════════════════════╝\n');

  const memory = await loadMemory();

  console.log(`Probing ${PRIORITY_FEEDS.length} feed(s)…\n`);

  const probes = await Promise.all(PRIORITY_FEEDS.map(probeFeed));

  // Print per-feed report
  for (const probe of probes) {
    const domain = (() => { try { return new URL(probe.url).hostname; } catch { return probe.url; } })();
    const memEntry = memory[domain];
    const memTotal = memEntry
      ? Object.values(memEntry).reduce((a, b) => a + b, 0)
      : 0;

    const statusIcon = {
      OK:             '✅',
      EMPTY:          '⚠️ ',
      FAIL:           '❌',
      FALLBACK_USED:  '🔄',
    }[probe.status];

    console.log(`${statusIcon} ${probe.status.padEnd(14)} ${probe.url}`);
    console.log(`   tags: [${probe.tags.join(', ')}]   confidence: ${probe.confidence}`);
    console.log(`   memory: ${memTotal} items recorded (${memEntry ? Object.entries(memEntry).filter(([_,n]) => n > 0).map(([p,n]) => `${p}:${n}`).join('+') : 'none'})`);

    if (probe.status === 'OK' || probe.status === 'FALLBACK_USED') {
      console.log(`   live:   ${probe.itemCount} items in feed | sourceFeed=${probe.sourceFeed}`);
      if (probe.pubDateRange) {
        console.log(`           pubDate range: ${probe.pubDateRange.oldest} → ${probe.pubDateRange.newest}`);
      }
      if (probe.sample) console.log(`           sample: "${probe.sample}"`);
    }

    if (probe.status === 'FALLBACK_USED') {
      console.log(`   ⚠️  primary failed, used fallback: ${probe.fallbackUrl}`);
      if (probe.primaryError) console.log(`           primary error: ${probe.primaryError}`);
    }

    if (probe.status === 'FAIL') {
      console.log(`   error: ${probe.primaryError}`);
      if (probe.fallbackUrl) console.log(`           fallback (${probe.fallbackUrl}) also failed`);
    }

    if (probe.status === 'EMPTY') {
      console.log(`   ⚠️  feed parsed OK but returned 0 items`);
    }

    console.log('');
  }

  // Summary table
  console.log('\n──────────────────────────────────────────────────────────────────────────');
  console.log(' SUMMARY');
  console.log('──────────────────────────────────────────────────────────────────────────');

  const byStatus = probes.reduce((acc, p) => {
    acc[p.status] = (acc[p.status] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  for (const [status, count] of Object.entries(byStatus)) {
    console.log(`  ${status.padEnd(15)} ${count}`);
  }

  // Identify orphan unverified feeds (in PRIORITY_FEEDS but no memory)
  console.log('\n  Memory vs Live status:');
  for (const probe of probes) {
    const domain = (() => { try { return new URL(probe.url).hostname; } catch { return probe.url; } })();
    const memEntry = memory[domain];
    const memTotal = memEntry ? Object.values(memEntry).reduce((a, b) => a + b, 0) : 0;

    if (memTotal === 0 && (probe.status === 'OK' || probe.status === 'FALLBACK_USED')) {
      console.log(`  🔍 ${domain}: live OK (${probe.itemCount} items) but 0 in memory — items rejected by LLM, or attributed elsewhere`);
    } else if (memTotal > 0 && probe.status === 'FAIL') {
      console.log(`  💀 ${domain}: ${memTotal} items in memory but feed is now DEAD`);
    }
  }

  console.log('');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
