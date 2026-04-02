/**
 * Pipeline — re-export shim
 *
 * The orchestration logic has moved to orchestrator/index.ts (Orchestrator).
 * This file preserves backward compatibility for pipeline-runner.ts and
 * any other consumers that import { Pipeline } from './pipeline'.
 */

export { Orchestrator as Pipeline } from './orchestrator/index';
