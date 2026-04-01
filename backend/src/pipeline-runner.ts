/**
 * Pipeline Runner — executed inside a Worker Thread by continuous-pipeline.ts
 *
 * When run as a worker, the parent can call worker.terminate() to instantly
 * stop execution regardless of what LLM call is in progress.
 */

import { workerData, isMainThread, parentPort } from 'worker_threads';
import { PrismaClient } from '@prisma/client';
import { Pipeline } from './pipeline';
import dotenv from 'dotenv';

dotenv.config();

// Guard: only run pipeline logic when inside a worker thread
if (!isMainThread) {
  const prisma = new PrismaClient();

  (async () => {
    try {
      const pipeline = new Pipeline(prisma);
      const result = await pipeline.run();
      parentPort?.postMessage({ success: true, runId: result.runId, articlesProcessed: result.articlesProcessed });
      await prisma.$disconnect();
    } catch (err) {
      parentPort?.postMessage({ success: false, error: (err as Error).message });
      await prisma.$disconnect();
    }
  })();
}
