/**
 * Topic Bank — The Brain
 *
 * Persists pre-triaged ScoutItems that were approved by the LLM but not
 * consumed in a given pipeline run.  Serves two purposes:
 *
 *   1. Pre-fill  — At the start of a new run, the Orchestrator recalls stored
 *                  topics per pillar before dispatching the Scout.  The Scout
 *                  only fills the remaining slots, saving LLM triage cost.
 *
 *   2. Fallback  — During runPillarQueue, if the main candidate pool is
 *                  exhausted before the article target is reached (e.g. after
 *                  multiple RED articles), the Orchestrator recalls banked
 *                  topics as backup candidates.
 *
 * Items are stored FIFO and recalled oldest-first.  Stale items (older than
 * MAX_AGE_DAYS) are pruned on load.  Items whose source URL appears in
 * ProcessedUrl are pruned by the Orchestrator before recall.
 */

import path from 'path';
import fs   from 'fs/promises';
import type { Pillar, ScoutItem } from '../../../shared/types';
import { PILLARS } from '../../../shared/types';

const BANK_FILE   = path.join(process.cwd(), 'data', 'topic-bank.json');
const MAX_AGE_DAYS = 14;

interface BankItem extends ScoutItem {
  savedAt: string; // ISO timestamp
}

export class TopicBank {
  private items: BankItem[] = [];

  // ── Persistence ──────────────────────────────────────────────────────────────

  async load(log: (msg: string) => void): Promise<void> {
    try {
      const raw  = await fs.readFile(BANK_FILE, 'utf-8');
      const all  = JSON.parse(raw) as BankItem[];
      const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
      this.items   = all.filter((item) => new Date(item.savedAt).getTime() > cutoff);
      const pruned = all.length - this.items.length;
      log(
        `[Brain] Loaded ${this.items.length} pre-triaged topic(s)` +
        (pruned > 0 ? ` (${pruned} stale entries pruned)` : '') +
        ` | ${this.summary()}`
      );
    } catch {
      this.items = [];
      log('[Brain] No topic bank found — starting fresh');
    }
  }

  async save(log: (msg: string) => void): Promise<void> {
    try {
      await fs.mkdir(path.dirname(BANK_FILE), { recursive: true });
      await fs.writeFile(BANK_FILE, JSON.stringify(this.items, null, 2), 'utf-8');
      log(`[Brain] Saved ${this.items.length} topic(s) | ${this.summary()}`);
    } catch (err) {
      log(`[Brain] Save failed (non-fatal): ${(err as Error).message}`);
    }
  }

  // ── Mutation ─────────────────────────────────────────────────────────────────

  /**
   * Add items to the bank, deduplicating by URL.
   * Returns the number of items actually added (duplicates skipped).
   */
  add(items: ScoutItem[]): number {
    const existingLinks = new Set(this.items.map((i) => i.link));
    const now = new Date().toISOString();
    let added = 0;
    for (const item of items) {
      if (!existingLinks.has(item.link)) {
        this.items.push({ ...item, savedAt: now });
        existingLinks.add(item.link);
        added++;
      }
    }
    return added;
  }

  /**
   * Recall up to `count` items for a pillar (FIFO — oldest saved first).
   * Recalled items are removed from the bank.
   * Returns plain ScoutItems (savedAt is stripped).
   */
  recall(pillar: Pillar, count: number): ScoutItem[] {
    const eligible    = this.items.filter((i) => i.pillar === pillar);
    const toRecall    = eligible.slice(0, count);
    const recallLinks = new Set(toRecall.map((i) => i.link));
    this.items        = this.items.filter((i) => !recallLinks.has(i.link));
    // Strip savedAt before returning
    return toRecall.map(({ savedAt: _savedAt, ...item }) => item);
  }

  /**
   * Remove items whose source URLs have already been processed.
   * Called by the Orchestrator after loading, using the ProcessedUrl table.
   * Returns the count of items pruned.
   */
  pruneProcessed(processedLinks: Set<string>): number {
    const before = this.items.length;
    this.items   = this.items.filter((i) => !processedLinks.has(i.link));
    return before - this.items.length;
  }

  // ── Queries ──────────────────────────────────────────────────────────────────

  getAvailableCount(pillar: Pillar): number {
    return this.items.filter((i) => i.pillar === pillar).length;
  }

  /** Per-pillar summary string for logging. */
  summary(): string {
    return PILLARS.map((p) => `${p}:${this.getAvailableCount(p)}`).join('  ');
  }
}
