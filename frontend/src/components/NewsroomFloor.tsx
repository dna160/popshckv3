import React, { useEffect, useRef, useState } from 'react';
import type { PipelineStatusData, DashboardStats } from '../types';
import { PILLAR_LABELS, PILLARS } from '../types';
import { triggerPipeline } from '../api';

interface NewsroomFloorProps {
  pipelineStatus: PipelineStatusData | null;
  stats: DashboardStats | null;
  onTriggerRefresh: () => void;
}

interface LogLine {
  timestamp: string;
  level: string;
  message: string;
  agent?: string;
}

function AgentIndicator({ name, active }: { name: string; active: boolean }) {
  return (
    <div className={`flex items-center gap-2 px-3 py-2 rounded-md border transition-all duration-300 ${
      active
        ? 'border-newsroom-blue/50 bg-newsroom-blue/10 text-newsroom-blue'
        : 'border-newsroom-border bg-newsroom-surface text-newsroom-subtle'
    }`}>
      <span className={`w-1.5 h-1.5 rounded-full ${active ? 'bg-newsroom-blue processing-pulse' : 'bg-newsroom-muted'}`} />
      <span className="text-xs font-mono">{name}</span>
    </div>
  );
}

function StatBlock({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="bg-newsroom-surface border border-newsroom-border rounded-lg p-3 text-center">
      <div className={`text-2xl font-mono font-bold ${color}`}>{value}</div>
      <div className="text-xs text-newsroom-subtle mt-1 uppercase tracking-wider">{label}</div>
    </div>
  );
}

function PillarBar({ pillar, count, total }: { pillar: string; count: number; total: number }) {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  const colors: Record<string, string> = {
    anime: 'bg-purple-500',
    gaming: 'bg-blue-500',
    infotainment: 'bg-cyan-500',
    manga: 'bg-orange-500',
    toys: 'bg-pink-500',
  };
  const barColor = colors[pillar] ?? 'bg-newsroom-blue';

  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs">
        <span className="text-newsroom-subtle truncate">{PILLAR_LABELS[pillar as keyof typeof PILLAR_LABELS]}</span>
        <span className="font-mono text-newsroom-text ml-2">{count}</span>
      </div>
      <div className="h-1.5 bg-newsroom-muted rounded-full overflow-hidden">
        <div
          className={`h-full ${barColor} rounded-full transition-all duration-500`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

// ── Full-screen log modal ─────────────────────────────────────────────────────

interface LogModalProps {
  logs: LogLine[];
  isRunning: boolean;
  onClose: () => void;
}

const LogModal: React.FC<LogModalProps> = ({ logs, isRunning, onClose }) => {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs.length]);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-newsroom-bg/95 backdrop-blur-sm"
      style={{ fontFamily: 'monospace' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-newsroom-border shrink-0">
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold text-newsroom-text">Pipeline Logs</span>
          {isRunning && (
            <span className="text-xs text-newsroom-blue font-mono processing-pulse">● LIVE</span>
          )}
          <span className="text-xs text-newsroom-subtle font-mono">{logs.length} entries</span>
        </div>
        <button
          onClick={onClose}
          className="text-newsroom-text hover:text-white bg-newsroom-muted hover:bg-newsroom-red/60 border border-newsroom-border rounded px-2 py-1 text-xs font-mono transition-colors"
          aria-label="Close log viewer"
        >
          ✕ Close
        </button>
      </div>

      {/* Log body */}
      <div className="flex-1 overflow-y-auto p-6 space-y-0.5">
        {logs.length === 0 ? (
          <p className="text-newsroom-subtle text-sm">No logs available.</p>
        ) : (
          logs.map((log, i) => (
            <div
              key={i}
              className={`flex gap-3 py-1 px-2 rounded text-xs hover:bg-newsroom-muted/20 ${
                log.level === 'error' ? 'text-newsroom-red' :
                log.level === 'warn' ? 'text-newsroom-yellow' :
                'text-newsroom-subtle'
              }`}
            >
              <span className="text-newsroom-muted shrink-0 w-20">
                {new Date(log.timestamp).toLocaleTimeString('en-US', { hour12: false })}
              </span>
              {log.agent && (
                <span className={`shrink-0 w-24 font-bold ${
                  log.agent === 'Scout' ? 'text-purple-400' :
                  log.agent === 'Researcher' ? 'text-cyan-400' :
                  log.agent === 'Copywriter' ? 'text-orange-400' :
                  log.agent === 'Editor' ? 'text-pink-400' :
                  'text-newsroom-blue'
                }`}>
                  [{log.agent}]
                </span>
              )}
              <span className="text-newsroom-text break-all leading-relaxed">{log.message}</span>
            </div>
          ))
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
};

// ── Main component ────────────────────────────────────────────────────────────

export const NewsroomFloor: React.FC<NewsroomFloorProps> = ({
  pipelineStatus,
  stats,
  onTriggerRefresh,
}) => {
  const logsEndRef = useRef<HTMLDivElement>(null);
  const [triggering, setTriggering] = useState(false);
  const [triggerError, setTriggerError] = useState<string | null>(null);
  const [showLogModal, setShowLogModal] = useState(false);

  const isRunning = pipelineStatus?.isRunning ?? false;
  const currentRun = pipelineStatus?.currentRun;
  const lastRun = pipelineStatus?.lastRun;
  const logs: LogLine[] = (currentRun?.logs ?? lastRun?.logs ?? []) as LogLine[];

  // Auto-scroll logs
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs.length]);

  async function handleTrigger() {
    setTriggering(true);
    setTriggerError(null);
    try {
      await triggerPipeline();
      onTriggerRefresh();
    } catch (err) {
      setTriggerError((err as Error).message);
    } finally {
      setTriggering(false);
    }
  }

  const activeAgents = isRunning
    ? logs
        .slice(-10)
        .map((l) => l.agent)
        .filter(Boolean)
    : [];

  return (
    <div className="flex flex-col h-full space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-newsroom-text">Newsroom Floor</h2>
          <p className="text-xs text-newsroom-subtle mt-0.5">Live pipeline operations</p>
        </div>
        <button
          onClick={handleTrigger}
          disabled={triggering || isRunning}
          className={`btn text-xs ${
            isRunning
              ? 'bg-newsroom-muted text-newsroom-subtle cursor-not-allowed border border-newsroom-border'
              : 'btn-primary'
          }`}
        >
          {isRunning ? (
            <>
              <span className="w-3 h-3 border border-newsroom-subtle/40 border-t-newsroom-subtle rounded-full animate-spin-slow" />
              Running...
            </>
          ) : triggering ? (
            'Triggering...'
          ) : (
            <>
              <span className="text-newsroom-bg">▶</span> Run Pipeline
            </>
          )}
        </button>
      </div>

      {triggerError && (
        <p className="text-xs text-newsroom-red bg-newsroom-red/10 border border-newsroom-red/20 rounded px-2 py-1.5">
          {triggerError}
        </p>
      )}

      {/* Pipeline Status */}
      <div className={`card border p-3 ${
        isRunning
          ? 'border-newsroom-blue/40 bg-newsroom-blue/5'
          : lastRun?.status === 'FAILED'
          ? 'border-newsroom-red/30'
          : 'border-newsroom-border'
      }`}>
        <div className="flex items-center gap-2 mb-2">
          <span className={`w-2 h-2 rounded-full ${
            isRunning ? 'bg-newsroom-blue processing-pulse' :
            lastRun?.status === 'COMPLETED' ? 'bg-newsroom-green' :
            lastRun?.status === 'FAILED' ? 'bg-newsroom-red' :
            'bg-newsroom-muted'
          }`} />
          <span className="text-xs font-mono text-newsroom-text">
            {isRunning ? 'PIPELINE RUNNING' :
             lastRun?.status === 'COMPLETED' ? 'LAST RUN: COMPLETED' :
             lastRun?.status === 'FAILED' ? 'LAST RUN: FAILED' :
             'IDLE — AWAITING TRIGGER'}
          </span>
        </div>

        {/* Active agents */}
        {isRunning && (
          <div className="grid grid-cols-2 gap-1.5 mt-2">
            {['Scout', 'Researcher', 'Copywriter', 'Editor'].map((agent) => (
              <AgentIndicator
                key={agent}
                name={agent}
                active={activeAgents.includes(agent)}
              />
            ))}
          </div>
        )}

        {/* Articles processed */}
        {(currentRun || lastRun) && (
          <p className="text-xs text-newsroom-subtle font-mono mt-2">
            Articles processed:{' '}
            <span className="text-newsroom-text">
              {(currentRun ?? lastRun)?.articlesProcessed ?? 0}
            </span>
          </p>
        )}
      </div>

      {/* Stats grid */}
      {stats && (
        <>
          <div className="grid grid-cols-3 gap-2">
            <StatBlock label="Green" value={stats.green} color="text-newsroom-green" />
            <StatBlock label="Yellow" value={stats.yellow} color="text-newsroom-yellow" />
            <StatBlock label="Red" value={stats.red} color="text-newsroom-red" />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <StatBlock label="Published" value={stats.published} color="text-newsroom-blue" />
            <StatBlock label="Processing" value={stats.processing} color="text-newsroom-subtle" />
            <StatBlock label="Failed" value={stats.failed} color="text-newsroom-subtle" />
          </div>

          {/* Per-pillar breakdown */}
          <div className="card p-3 space-y-2.5">
            <p className="section-title">Articles by Pillar</p>
            {PILLARS.map((pillar) => (
              <PillarBar
                key={pillar}
                pillar={pillar}
                count={stats.byPillar[pillar] ?? 0}
                total={stats.total}
              />
            ))}
          </div>
        </>
      )}

      {/* Live logs */}
      <div className="card flex-1 flex flex-col min-h-0 overflow-hidden">
        <div className="px-3 py-2 border-b border-newsroom-border flex items-center justify-between">
          <p className="section-title">Pipeline Logs</p>
          <div className="flex items-center gap-2">
            {isRunning && (
              <span className="text-xs text-newsroom-blue font-mono processing-pulse">LIVE</span>
            )}
            <button
              onClick={() => setShowLogModal(true)}
              className="text-xs text-newsroom-subtle hover:text-newsroom-blue font-mono border border-newsroom-border hover:border-newsroom-blue/40 rounded px-2 py-0.5 transition-colors"
              title="Expand logs to full screen"
            >
              Expand Logs ↗
            </button>
          </div>
        </div>
        <div
          className="flex-1 overflow-y-auto log-container p-2 space-y-0.5 font-mono text-xs min-h-[200px] cursor-pointer"
          onClick={() => setShowLogModal(true)}
          title="Click to expand logs"
        >
          {logs.length === 0 ? (
            <p className="text-newsroom-subtle p-2">No logs available. Click to expand.</p>
          ) : (
            logs.map((log, i) => (
              <div
                key={i}
                className={`flex gap-2 py-0.5 px-1 rounded hover:bg-newsroom-muted/30 ${
                  log.level === 'error' ? 'text-newsroom-red' :
                  log.level === 'warn' ? 'text-newsroom-yellow' :
                  'text-newsroom-subtle'
                }`}
              >
                <span className="text-newsroom-muted shrink-0">
                  {new Date(log.timestamp).toLocaleTimeString('en-US', { hour12: false })}
                </span>
                {log.agent && (
                  <span className="text-newsroom-blue shrink-0">[{log.agent}]</span>
                )}
                <span className="text-newsroom-text break-all">{log.message}</span>
              </div>
            ))
          )}
          <div ref={logsEndRef} />
        </div>
      </div>

      {/* Full-screen log modal */}
      {showLogModal && (
        <LogModal
          logs={logs}
          isRunning={isRunning}
          onClose={() => setShowLogModal(false)}
        />
      )}
    </div>
  );
};
