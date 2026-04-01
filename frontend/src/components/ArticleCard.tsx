import React, { useState } from 'react';
import type { Article } from '../types';
import { PILLAR_LABELS, PILLAR_COLORS } from '../types';
import { publishArticle, discardArticle } from '../api';

interface ArticleCardProps {
  article: Article;
  onRefresh: () => void;
}

const STATUS_CONFIG = {
  GREEN: {
    dot: 'bg-newsroom-green',
    border: 'border-newsroom-green/30',
    bg: 'bg-newsroom-green/5',
    label: 'Auto-Published',
    labelClass: 'text-newsroom-green bg-newsroom-green/10 border-newsroom-green/30',
  },
  YELLOW: {
    dot: 'bg-newsroom-yellow',
    border: 'border-newsroom-yellow/30',
    bg: 'bg-newsroom-yellow/5',
    label: 'Pending Review',
    labelClass: 'text-newsroom-yellow bg-newsroom-yellow/10 border-newsroom-yellow/30',
  },
  RED: {
    dot: 'bg-newsroom-red',
    border: 'border-newsroom-red/30',
    bg: 'bg-newsroom-red/5',
    label: 'Failed — Review Required',
    labelClass: 'text-newsroom-red bg-newsroom-red/10 border-newsroom-red/30',
  },
  PROCESSING: {
    dot: 'bg-newsroom-blue processing-pulse',
    border: 'border-newsroom-blue/30',
    bg: 'bg-newsroom-blue/5',
    label: 'Processing',
    labelClass: 'text-newsroom-blue bg-newsroom-blue/10 border-newsroom-blue/30',
  },
  PUBLISHED: {
    dot: 'bg-newsroom-green',
    border: 'border-newsroom-green/20',
    bg: 'bg-transparent',
    label: 'Published',
    labelClass: 'text-newsroom-green bg-newsroom-green/10 border-newsroom-green/30',
  },
  FAILED: {
    dot: 'bg-newsroom-red',
    border: 'border-newsroom-red/20',
    bg: 'bg-transparent',
    label: '3-Strike Failure',
    labelClass: 'text-newsroom-red bg-newsroom-red/10 border-newsroom-red/30',
  },
};

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export const ArticleCard: React.FC<ArticleCardProps> = ({ article, onRefresh }) => {
  const [publishing, setPublishing] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cfg = STATUS_CONFIG[article.status] ?? STATUS_CONFIG.PROCESSING;
  const pillarColor = PILLAR_COLORS[article.pillar] ?? 'text-newsroom-subtle border-newsroom-border bg-newsroom-muted/10';
  const canPublish = ['YELLOW', 'RED', 'GREEN'].includes(article.status);
  const canDiscard = ['YELLOW', 'RED', 'FAILED'].includes(article.status);

  async function handlePublish() {
    setPublishing(true);
    setError(null);
    try {
      await publishArticle(article.id);
      onRefresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPublishing(false);
    }
  }

  async function handleDiscard() {
    if (!confirm(`Discard article "${article.title}"? This cannot be undone.`)) return;
    setDiscarding(true);
    setError(null);
    try {
      await discardArticle(article.id);
      onRefresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDiscarding(false);
    }
  }

  const featuredImage = article.images?.find((img) => img.isFeatured);

  return (
    <div className={`card border ${cfg.border} ${cfg.bg} overflow-hidden transition-all duration-200`}>
      {/* Featured image thumbnail */}
      {featuredImage && (
        <div className="h-32 overflow-hidden bg-newsroom-muted">
          <img
            src={featuredImage.url}
            alt={featuredImage.alt}
            className="w-full h-full object-cover opacity-80"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = 'none';
            }}
          />
        </div>
      )}

      <div className="p-4 space-y-3">
        {/* Header row */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 flex-wrap">
            {/* Status dot + badge */}
            <span className={`status-badge border ${cfg.labelClass}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot} inline-block`} />
              {cfg.label}
            </span>
            {/* Pillar badge */}
            <span className={`status-badge border ${pillarColor}`}>
              {PILLAR_LABELS[article.pillar]}
            </span>
          </div>
          {/* Revision count */}
          {article.revisionCount > 0 && (
            <span className="text-xs font-mono text-newsroom-subtle whitespace-nowrap">
              {article.revisionCount} rev{article.revisionCount !== 1 ? 's' : ''}
            </span>
          )}
        </div>

        {/* Title */}
        <h3 className="text-sm font-semibold text-newsroom-text leading-snug line-clamp-2">
          {article.title}
        </h3>

        {/* Timestamp */}
        <p className="text-xs text-newsroom-subtle font-mono">
          {formatDate(article.createdAt)}
        </p>

        {/* Editor notes (RED articles) */}
        {article.status === 'RED' && article.editorNotes && (
          <div className="bg-newsroom-red/10 border border-newsroom-red/20 rounded p-2.5">
            <p className="text-xs font-mono text-newsroom-subtle mb-1">Editor Notes:</p>
            <p className={`text-xs text-newsroom-text leading-relaxed ${expanded ? '' : 'line-clamp-3'}`}>
              {article.editorNotes}
            </p>
            {article.editorNotes.length > 150 && (
              <button
                onClick={() => setExpanded(!expanded)}
                className="text-xs text-newsroom-blue mt-1 hover:underline"
              >
                {expanded ? 'Show less' : 'Show more'}
              </button>
            )}
          </div>
        )}

        {/* YELLOW editor notes */}
        {article.status === 'YELLOW' && article.editorNotes && (
          <div className="bg-newsroom-yellow/5 border border-newsroom-yellow/20 rounded p-2.5">
            <p className="text-xs font-mono text-newsroom-subtle mb-1">Passed after revision:</p>
            <p className={`text-xs text-newsroom-text leading-relaxed ${expanded ? '' : 'line-clamp-2'}`}>
              {article.editorNotes}
            </p>
            {article.editorNotes.length > 100 && (
              <button
                onClick={() => setExpanded(!expanded)}
                className="text-xs text-newsroom-blue mt-1 hover:underline"
              >
                {expanded ? 'Show less' : 'Show more'}
              </button>
            )}
          </div>
        )}

        {/* Published WP link */}
        {article.wpPostUrl && (
          <a
            href={article.wpPostUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-newsroom-blue hover:underline font-mono block truncate"
          >
            {article.wpPostUrl}
          </a>
        )}

        {/* Error */}
        {error && (
          <p className="text-xs text-newsroom-red bg-newsroom-red/10 border border-newsroom-red/20 rounded px-2 py-1.5">
            {error}
          </p>
        )}

        {/* Image count */}
        {article.images && article.images.length > 0 && (
          <p className="text-xs text-newsroom-subtle font-mono">
            {article.images.length} image{article.images.length !== 1 ? 's' : ''}
          </p>
        )}

        {/* Source link */}
        <a
          href={article.sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-newsroom-subtle hover:text-newsroom-blue font-mono block truncate"
        >
          {article.sourceUrl}
        </a>

        {/* Actions */}
        {(canPublish || canDiscard) && (
          <div className="flex gap-2 pt-1">
            {canPublish && article.status !== 'PUBLISHED' && (
              <button
                onClick={handlePublish}
                disabled={publishing}
                className="btn-primary flex-1 justify-center text-xs"
              >
                {publishing ? (
                  <>
                    <span className="w-3 h-3 border border-newsroom-bg/40 border-t-newsroom-bg rounded-full animate-spin" />
                    Publishing...
                  </>
                ) : (
                  'Publish to WP'
                )}
              </button>
            )}
            {canDiscard && (
              <button
                onClick={handleDiscard}
                disabled={discarding}
                className="btn-danger flex-1 justify-center text-xs"
              >
                {discarding ? 'Discarding...' : 'Discard'}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
