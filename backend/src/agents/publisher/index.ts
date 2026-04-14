/**
 * Agent 5: Web Publisher
 *
 * Responsibilities:
 * - Receive a PASS article from the Master Orchestrator (Editor-approved)
 * - Map author persona name → WordPress User ID
 * - Map content pillar → WordPress Category ID
 * - Convert Markdown to HTML (handled by pipeline before dispatch)
 * - Upload images to WordPress media library
 * - Create the WordPress post with correct author, category, and featured image
 * - Auto-retry on transient WordPress errors (up to MAX_RETRIES attempts)
 * - Return the live WordPress URL to the orchestrator for dashboard streaming
 *
 * Isolation guarantee: Any WordPress API failure is caught here and retried
 * internally. The Master Orchestrator and Copywriters are never blocked by
 * WordPress downtime — the Publisher handles all recovery autonomously.
 */

import type { ArticleImage, Pillar } from '../../shared/types';
import { publishToWordPress } from './tools/wp_api_client';

const MAX_RETRIES    = 3;
const RETRY_DELAY_MS = 2000; // base delay; doubles on each retry

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class Publisher {
  private log: (msg: string) => void;

  constructor(log: (msg: string) => void = console.log) {
    this.log = log;
  }

  /**
   * Publish an article to WordPress with automatic retry on transient errors.
   *
   * @param title       - Indonesian headline (from Copywriter's H1)
   * @param contentHtml - Full HTML article body (Markdown already converted)
   * @param images      - Array of sourced images (one flagged as featured)
   * @param pillar      - Content pillar → determines WP Category ID
   * @param authorName  - Copywriter persona name → determines WP Author ID
   *                      ('Satoshi' | 'Hikari' | 'Kenji' | 'Rina' | 'Taro')
   */
  async publish(params: {
    title:       string;
    contentHtml: string;
    images:      ArticleImage[];
    pillar:      Pillar;
    authorName:  string;
  }): Promise<{ wpPostId: number; wpPostUrl: string }> {
    const { title, authorName, pillar } = params;

    if (!process.env.WP_BASE_URL && !process.env.WP_URL) {
      throw new Error('WordPress not configured (WP_BASE_URL not set)');
    }

    this.log(`[Publisher] Publishing "${title}" — author: ${authorName}, pillar: ${pillar}`);

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const result = await publishToWordPress(params);
        this.log(
          `[Publisher] ✓ Published "${title}" → WP Post ID: ${result.wpPostId} | ${result.wpPostUrl}`
        );
        return result;
      } catch (err) {
        lastError = err as Error;
        const isTransient = this.isTransientError(lastError);

        if (!isTransient || attempt === MAX_RETRIES) {
          this.log(`[Publisher] ✗ Publish failed (attempt ${attempt}/${MAX_RETRIES}): ${lastError.message}`);
          break;
        }

        const delay = RETRY_DELAY_MS * Math.pow(2, attempt - 1);
        this.log(
          `[Publisher] ⚠ Transient error (attempt ${attempt}/${MAX_RETRIES}): ${lastError.message}. ` +
          `Retrying in ${delay}ms...`
        );
        await sleep(delay);
      }
    }

    throw lastError ?? new Error('Publisher: unknown publish failure');
  }

  /**
   * Determine whether an error is transient (network timeout, 5xx) and worth retrying.
   * Non-transient errors (400 Bad Request, 401 Unauthorized, 403 Forbidden) are
   * not retried — they indicate configuration or content issues, not server load.
   */
  private isTransientError(err: Error): boolean {
    const msg = err.message.toLowerCase();
    if (msg.includes('502') || msg.includes('503') || msg.includes('504')) return true;
    if (msg.includes('timeout') || msg.includes('econnreset') || msg.includes('network')) return true;
    if (msg.includes('429')) return true; // rate limited
    return false;
  }
}
