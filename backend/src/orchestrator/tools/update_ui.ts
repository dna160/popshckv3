/**
 * Orchestrator Tool: update_ui
 *
 * Streams the Orchestrator's current log state to the database so the
 * Dashboard UI reflects live pipeline progress without polling lag.
 *
 * Called by the Orchestrator at every state transition:
 *   - After each agent completes its work
 *   - After each article status change (PROCESSING → GREEN/YELLOW/RED)
 *   - After each WordPress publish attempt
 */

import { PrismaClient } from '@prisma/client';
import type { PipelineLogEntry } from '../../shared/types';

/**
 * Persist the current log snapshot to the active pipeline run.
 * Fire-and-forget — the Orchestrator never awaits this; failures are silent
 * so a DB hiccup never blocks the pipeline.
 */
export function updateUI(
  prisma: PrismaClient,
  runId:  string,
  logs:   PipelineLogEntry[]
): void {
  prisma.pipelineRun
    .update({
      where: { id: runId },
      data:  { logs: JSON.stringify(logs) },
    })
    .catch(() => {/* non-fatal — UI may be momentarily stale */});
}

/**
 * Update a single article's state in the database.
 * Used by the Orchestrator to reflect status changes (PROCESSING → GREEN etc.)
 * and to attach content, images, editor notes, and WordPress metadata.
 */
export async function updateArticleState(
  prisma: PrismaClient,
  id:     string,
  data: {
    title?:         string;
    status?:        string;
    content?:       string;
    contentHtml?:   string;
    images?:        string;
    editorNotes?:   string;
    revisionCount?: number;
    wpPostId?:      number;
    wpPostUrl?:     string;
  }
): Promise<void> {
  await prisma.article.update({ where: { id }, data });
}
