/**
 * Orchestrator Tool: dispatch_agent
 *
 * Provides typed, logged dispatching of the Master Orchestrator's payloads
 * to the appropriate Specialized Agent.
 *
 * The Orchestrator calls dispatchAgent() at every routing decision point,
 * producing a structured log entry that makes its decisions visible in the
 * pipeline log stream and the Dashboard.
 */

import type { Pillar } from '../../../../shared/types';

// ── Agent registry ────────────────────────────────────────────────────────────

export type AgentHandle =
  | 'scout'
  | 'researcher'
  | 'copywriters/anime_satoshi'
  | 'copywriters/gaming_hikari'
  | 'copywriters/infotainment_kenji'
  | 'copywriters/manga_rina'
  | 'copywriters/toys_taro'
  | 'editor'
  | 'publisher';

/** Maps each content pillar to its dedicated Copywriter agent handle. */
export const PILLAR_AGENT_MAP: Record<Pillar, AgentHandle> = {
  anime:        'copywriters/anime_satoshi',
  gaming:       'copywriters/gaming_hikari',
  infotainment: 'copywriters/infotainment_kenji',
  manga:        'copywriters/manga_rina',
  toys:         'copywriters/toys_taro',
};

/** Maps each Copywriter handle to the persona's display name. */
export const AGENT_PERSONA_MAP: Record<string, string> = {
  'copywriters/anime_satoshi':       'Satoshi',
  'copywriters/gaming_hikari':       'Hikari',
  'copywriters/infotainment_kenji':  'Kenji',
  'copywriters/manga_rina':          'Rina',
  'copywriters/toys_taro':           'Taro',
};

// ── Dispatch record ───────────────────────────────────────────────────────────

export interface DispatchRecord {
  agent:     AgentHandle;
  persona?:  string;     // persona name for copywriter agents
  payload:   string;     // human-readable payload summary (topic/article title)
  timestamp: string;
}

/**
 * Create a DispatchRecord and emit a structured log message through the
 * provided log callback.
 *
 * Usage:
 *   const d = dispatchAgent('copywriters/gaming_hikari', topic.title, this.log);
 *   // log already emitted: "[Orchestrator] → dispatch(copywriters/gaming_hikari | Hikari): ..."
 */
export function dispatchAgent(
  agent:   AgentHandle,
  payload: string,
  log:     (msg: string) => void
): DispatchRecord {
  const persona = AGENT_PERSONA_MAP[agent];
  const label   = persona ? `${agent} | ${persona}` : agent;

  log(`[Orchestrator] → dispatch(${label}): "${payload}"`);

  return {
    agent,
    persona,
    payload,
    timestamp: new Date().toISOString(),
  };
}
