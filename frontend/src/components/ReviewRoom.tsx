import React, { useState } from 'react';
import type { Article, ArticleStatus, Pillar } from '../types';
import { PILLAR_LABELS, PILLARS } from '../types';
import { ArticleCard } from './ArticleCard';

interface ReviewRoomProps {
  articles: Article[];
  onRefresh: () => void;
}

type FilterStatus = 'ALL' | ArticleStatus;
type SortField = 'date' | 'pillar' | 'revisions';

const STATUS_TABS: Array<{ value: FilterStatus; label: string; color: string }> = [
  { value: 'ALL',        label: 'All',        color: 'text-newsroom-subtle' },
  { value: 'YELLOW',     label: 'Pending',    color: 'text-newsroom-yellow' },
  { value: 'RED',        label: 'Failed',     color: 'text-newsroom-red' },
  { value: 'GREEN',      label: 'Auto-Pass',  color: 'text-newsroom-green' },
  { value: 'PUBLISHED',  label: 'Published',  color: 'text-newsroom-blue' },
  { value: 'PROCESSING', label: 'Processing', color: 'text-newsroom-subtle' },
  { value: 'FAILED',     label: '3-Strike',   color: 'text-newsroom-subtle' },
];

export const ReviewRoom: React.FC<ReviewRoomProps> = ({ articles, onRefresh }) => {
  const [statusFilter, setStatusFilter] = useState<FilterStatus>('ALL');
  const [pillarFilter, setPillarFilter] = useState<Pillar | 'ALL'>('ALL');
  const [sortField, setSortField] = useState<SortField>('date');
  const [searchQuery, setSearchQuery] = useState('');

  // Compute tab counts
  const tabCounts = STATUS_TABS.reduce<Record<string, number>>((acc, tab) => {
    acc[tab.value] = tab.value === 'ALL'
      ? articles.length
      : articles.filter((a) => a.status === tab.value).length;
    return acc;
  }, {});

  // Filter
  let filtered = articles.filter((a) => {
    if (statusFilter !== 'ALL' && a.status !== statusFilter) return false;
    if (pillarFilter !== 'ALL' && a.pillar !== pillarFilter) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      return a.title.toLowerCase().includes(q) || PILLAR_LABELS[a.pillar].toLowerCase().includes(q);
    }
    return true;
  });

  // Sort
  filtered = [...filtered].sort((a, b) => {
    if (sortField === 'date') {
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    }
    if (sortField === 'pillar') {
      return a.pillar.localeCompare(b.pillar);
    }
    if (sortField === 'revisions') {
      return b.revisionCount - a.revisionCount;
    }
    return 0;
  });

  const pendingCount = articles.filter((a) => a.status === 'YELLOW' || a.status === 'RED').length;

  return (
    <div className="flex flex-col h-full space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-base font-semibold text-newsroom-text">Review Room</h2>
          <p className="text-xs text-newsroom-subtle mt-0.5">
            {pendingCount > 0
              ? `${pendingCount} article${pendingCount !== 1 ? 's' : ''} awaiting human review`
              : 'No articles pending review'}
          </p>
        </div>
        <div className="text-xs font-mono text-newsroom-subtle">
          {filtered.length} / {articles.length}
        </div>
      </div>

      {/* Status tabs */}
      <div className="flex gap-1 overflow-x-auto pb-1 -mx-1 px-1">
        {STATUS_TABS.map((tab) => (
          <button
            key={tab.value}
            onClick={() => setStatusFilter(tab.value)}
            className={`shrink-0 px-3 py-1.5 rounded-md text-xs font-medium transition-all duration-150 border ${
              statusFilter === tab.value
                ? `${tab.color} border-current bg-current/10`
                : 'text-newsroom-subtle border-transparent hover:border-newsroom-border hover:text-newsroom-text'
            }`}
          >
            {tab.label}
            {tabCounts[tab.value] > 0 && (
              <span className="ml-1.5 font-mono">{tabCounts[tab.value]}</span>
            )}
          </button>
        ))}
      </div>

      {/* Filters row */}
      <div className="flex gap-2 items-center flex-wrap">
        {/* Search */}
        <input
          type="text"
          placeholder="Search articles..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="flex-1 min-w-[140px] bg-newsroom-surface border border-newsroom-border rounded-md px-3 py-1.5 text-xs text-newsroom-text placeholder-newsroom-subtle focus:outline-none focus:border-newsroom-blue/50"
        />

        {/* Pillar filter */}
        <select
          value={pillarFilter}
          onChange={(e) => setPillarFilter(e.target.value as Pillar | 'ALL')}
          className="bg-newsroom-surface border border-newsroom-border rounded-md px-2 py-1.5 text-xs text-newsroom-text focus:outline-none focus:border-newsroom-blue/50"
        >
          <option value="ALL">All Pillars</option>
          {PILLARS.map((p) => (
            <option key={p} value={p}>{PILLAR_LABELS[p]}</option>
          ))}
        </select>

        {/* Sort */}
        <select
          value={sortField}
          onChange={(e) => setSortField(e.target.value as SortField)}
          className="bg-newsroom-surface border border-newsroom-border rounded-md px-2 py-1.5 text-xs text-newsroom-text focus:outline-none focus:border-newsroom-blue/50"
        >
          <option value="date">Sort: Latest</option>
          <option value="pillar">Sort: Pillar</option>
          <option value="revisions">Sort: Revisions</option>
        </select>
      </div>

      {/* Article grid */}
      {filtered.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center py-16">
          <div className="w-12 h-12 rounded-full bg-newsroom-surface border border-newsroom-border flex items-center justify-center mb-3">
            <span className="text-2xl">📰</span>
          </div>
          <p className="text-sm text-newsroom-subtle">No articles found</p>
          <p className="text-xs text-newsroom-muted mt-1">
            {articles.length === 0
              ? 'Run the pipeline to generate articles'
              : 'Try adjusting your filters'}
          </p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto -mx-1 px-1">
          <div className="grid grid-cols-1 gap-3 pb-4">
            {filtered.map((article) => (
              <ArticleCard key={article.id} article={article} onRefresh={onRefresh} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
