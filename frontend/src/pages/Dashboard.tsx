import React, { useEffect, useState, useCallback, useRef } from 'react';
import { NewsroomFloor } from '../components/NewsroomFloor';
import { ReviewRoom } from '../components/ReviewRoom';
import type { Article, PipelineStatusData, DashboardStats } from '../types';
import {
  getArticles,
  getPipelineStatus,
  getDashboardStats,
  triggerPipeline,
  abortPipeline,
} from '../api';

const POLL_INTERVAL_MS = 5000;

function useInterval(callback: () => void, delay: number) {
  const savedCallback = useRef(callback);
  useEffect(() => { savedCallback.current = callback; }, [callback]);
  useEffect(() => {
    const id = setInterval(() => savedCallback.current(), delay);
    return () => clearInterval(id);
  }, [delay]);
}

export const Dashboard: React.FC = () => {
  const [articles, setArticles] = useState<Article[]>([]);
  const [pipelineStatus, setPipelineStatus] = useState<PipelineStatusData | null>(null);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());
  const [error, setError] = useState<string | null>(null);
  const [aborting, setAborting] = useState(false);
  const [triggering, setTriggering] = useState(false);

  const fetchAll = useCallback(async () => {
    try {
      const [articlesData, statusData, statsData] = await Promise.all([
        getArticles(),
        getPipelineStatus(),
        getDashboardStats(),
      ]);
      setArticles(articlesData);
      setPipelineStatus(statusData);
      setStats(statsData);
      setError(null);
      setLastRefresh(new Date());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial fetch
  useEffect(() => { fetchAll(); }, [fetchAll]);

  // Polling every 5s
  useInterval(fetchAll, POLL_INTERVAL_MS);

  return (
    <div className="min-h-screen bg-newsroom-bg flex flex-col">
      {/* Top bar */}
      <header className="border-b border-newsroom-border bg-newsroom-surface/80 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-screen-2xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            {/* Logo mark */}
            <div className="w-7 h-7 rounded bg-newsroom-blue/20 border border-newsroom-blue/30 flex items-center justify-center">
              <span className="text-newsroom-blue text-sm font-mono font-bold">N</span>
            </div>
            <div>
              <h1 className="text-sm font-semibold text-newsroom-text tracking-tight">
                Synthetic Newsroom
              </h1>
              <p className="text-xs text-newsroom-subtle">Operations Dashboard</p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {/* Pipeline status pill */}
            <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs font-mono ${
              pipelineStatus?.isRunning
                ? 'border-newsroom-blue/40 bg-newsroom-blue/10 text-newsroom-blue'
                : 'border-newsroom-border text-newsroom-subtle'
            }`}>
              <span className={`w-1.5 h-1.5 rounded-full ${
                pipelineStatus?.isRunning ? 'bg-newsroom-blue processing-pulse' : 'bg-newsroom-muted'
              }`} />
              {pipelineStatus?.isRunning ? 'Running' : 'Idle'}
            </div>

            {/* Run button — only shown while pipeline is idle */}
            {!pipelineStatus?.isRunning && (
              <button
                onClick={async () => {
                  setTriggering(true);
                  try {
                    await triggerPipeline();
                    await fetchAll();
                  } catch (err) {
                    setError((err as Error).message);
                  } finally {
                    setTriggering(false);
                  }
                }}
                disabled={triggering}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-newsroom-green/40 bg-newsroom-green/10 text-newsroom-green text-xs font-mono hover:bg-newsroom-green/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-newsroom-green" />
                {triggering ? 'Starting…' : 'Run Pipeline'}
              </button>
            )}

            {/* Abort button — only shown while pipeline is running */}
            {pipelineStatus?.isRunning && (
              <button
                onClick={async () => {
                  if (!confirm('Abort the running pipeline? In-progress articles will be marked as failed.')) return;
                  setAborting(true);
                  try {
                    await abortPipeline();
                    await fetchAll();
                  } catch (err) {
                    setError((err as Error).message);
                  } finally {
                    setAborting(false);
                  }
                }}
                disabled={aborting}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-newsroom-red/40 bg-newsroom-red/10 text-newsroom-red text-xs font-mono hover:bg-newsroom-red/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <span className="w-1.5 h-1.5 rounded-sm bg-newsroom-red" />
                {aborting ? 'Aborting…' : 'Abort'}
              </button>
            )}

            {/* Refresh indicator */}
            <div className="text-xs text-newsroom-subtle font-mono">
              {loading ? (
                <span className="flex items-center gap-1">
                  <span className="w-3 h-3 border border-newsroom-subtle/30 border-t-newsroom-subtle rounded-full animate-spin-slow" />
                  Loading...
                </span>
              ) : (
                <span title={`Last refresh: ${lastRefresh.toLocaleTimeString()}`}>
                  {error ? (
                    <span className="text-newsroom-red">Connection error</span>
                  ) : (
                    `Refreshes every ${POLL_INTERVAL_MS / 1000}s`
                  )}
                </span>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* Error banner */}
      {error && (
        <div className="bg-newsroom-red/10 border-b border-newsroom-red/20 px-4 py-2">
          <p className="text-xs text-newsroom-red font-mono max-w-screen-2xl mx-auto">
            API Error: {error} — Is the backend running on port 3001?
          </p>
        </div>
      )}

      {/* Main layout: two-panel */}
      <main className="flex-1 max-w-screen-2xl mx-auto w-full px-4 py-4">
        <div className="grid grid-cols-1 lg:grid-cols-[380px_1fr] gap-4 h-full">
          {/* Left panel: Newsroom Floor */}
          <aside className="lg:sticky lg:top-[57px] lg:h-[calc(100vh-57px)] lg:overflow-y-auto pb-4">
            <NewsroomFloor
              pipelineStatus={pipelineStatus}
              stats={stats}
              onTriggerRefresh={fetchAll}
            />
          </aside>

          {/* Right panel: Review Room */}
          <section className="min-h-[600px]">
            <ReviewRoom
              articles={articles}
              onRefresh={fetchAll}
            />
          </section>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-newsroom-border py-3 px-4">
        <div className="max-w-screen-2xl mx-auto flex items-center justify-between">
          <p className="text-xs text-newsroom-subtle font-mono">
            Synthetic Newsroom POC v1.0 — 5 Content Pillars — Grok-4-1-fast-reasoning
          </p>
          <p className="text-xs text-newsroom-subtle font-mono">
            {stats?.total ?? 0} articles total
          </p>
        </div>
      </footer>
    </div>
  );
};
