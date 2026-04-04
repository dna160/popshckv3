/**
 * API client for the Synthetic Newsroom backend.
 * Uses VITE_API_URL env var if set, otherwise falls back to the production backend.
 * In dev, Vite proxy forwards /api → localhost:3003 (relative URL works locally).
 */

import type {
  Article,
  PipelineStatusData,
  DashboardStats,
  ApiResponse,
} from './types';

const BASE = (import.meta.env.VITE_API_URL || 'https://back-end-production-14be.up.railway.app') + '/api';

async function request<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });

  // Handle non-JSON responses (e.g. proxy 404 when backend is down)
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    throw new Error(`Backend unavailable (HTTP ${res.status}). Check that the backend service is running.`);
  }

  const json = (await res.json()) as ApiResponse<T>;

  if (!json.success || json.data === undefined) {
    throw new Error(json.error || `Request failed: ${res.status}`);
  }

  return json.data;
}

// ── Articles ──────────────────────────────────────────────────────────────────

export async function getArticles(): Promise<Article[]> {
  return request<Article[]>('/articles');
}

export async function getArticle(id: string): Promise<Article> {
  return request<Article>(`/articles/${id}`);
}

export async function publishArticle(id: string): Promise<{ wpPostId: number; wpPostUrl: string }> {
  return request(`/articles/${id}/publish`, { method: 'POST' });
}

export async function discardArticle(id: string): Promise<{ id: string }> {
  return request(`/articles/${id}`, { method: 'DELETE' });
}

export async function updateArticleContent(id: string, content: string): Promise<Article> {
  return request<Article>(`/articles/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ content }),
  });
}

// ── Pipeline ──────────────────────────────────────────────────────────────────

export async function getPipelineStatus(): Promise<PipelineStatusData> {
  return request<PipelineStatusData>('/pipeline/status');
}

export async function triggerPipeline(): Promise<{ message: string }> {
  return request('/pipeline/trigger', { method: 'POST' });
}

export async function abortPipeline(): Promise<{ aborted: boolean }> {
  return request('/pipeline/abort', { method: 'POST' });
}

export async function getPipelineLogs(): Promise<{
  runId: string | null;
  status: string;
  logs: Array<{ timestamp: string; level: string; message: string; agent?: string }>;
  articlesProcessed: number;
  startedAt: string;
  completedAt: string | null;
}> {
  return request('/pipeline/logs');
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

export async function getDashboardStats(): Promise<DashboardStats> {
  return request<DashboardStats>('/dashboard/stats');
}
