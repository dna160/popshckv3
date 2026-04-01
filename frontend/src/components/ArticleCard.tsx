import React, { useState } from 'react';
import type { Article } from '../types';
import { PILLAR_LABELS, PILLAR_COLORS } from '../types';
import { publishArticle, discardArticle, getArticle, updateArticleContent } from '../api';

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
    label: '3-Strike Failure',
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

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// ── Draft Modal ───────────────────────────────────────────────────────────────

interface DraftModalProps {
  article: Article;
  fullArticle: Article | null;
  loading: boolean;
  onClose: () => void;
}

const DraftModal: React.FC<DraftModalProps> = ({ article, fullArticle, loading, onClose }) => {
  const content = fullArticle?.contentHtml || fullArticle?.content || null;
  const images = fullArticle?.images || article.images || [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-newsroom-surface border border-newsroom-border rounded-xl w-full max-w-3xl max-h-[90vh] flex flex-col shadow-2xl">
        {/* Modal header */}
        <div className="flex items-start justify-between gap-4 px-6 py-4 border-b border-newsroom-border shrink-0">
          <div>
            <p className="text-xs font-mono text-newsroom-subtle mb-1">
              {PILLAR_LABELS[article.pillar]} — {article.status}
            </p>
            <h2 className="text-sm font-semibold text-newsroom-text leading-snug">
              {article.title}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="text-newsroom-subtle hover:text-newsroom-text text-lg leading-none shrink-0 mt-0.5"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* Modal body */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <span className="w-6 h-6 border-2 border-newsroom-blue/30 border-t-newsroom-blue rounded-full animate-spin" />
            </div>
          ) : !content ? (
            <p className="text-newsroom-subtle text-sm text-center py-8">No draft content available.</p>
          ) : (
            <>
              {/* Images */}
              {images.length > 0 && (
                <div className="flex gap-3 overflow-x-auto pb-1">
                  {images.map((img, idx) => (
                    <div key={idx} className="shrink-0 w-40">
                      <img
                        src={img.url}
                        alt={img.alt}
                        className="w-40 h-28 object-cover rounded-lg border border-newsroom-border"
                        onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                      />
                      <p className="text-xs text-newsroom-subtle mt-1 truncate">
                        {img.isFeatured ? '★ Featured — ' : ''}{img.alt}
                      </p>
                    </div>
                  ))}
                </div>
              )}

              {/* Article content */}
              {fullArticle?.contentHtml ? (
                <div
                  className="prose prose-invert prose-sm max-w-none text-newsroom-text leading-relaxed"
                  dangerouslySetInnerHTML={{ __html: fullArticle.contentHtml }}
                />
              ) : (
                <pre className="text-xs text-newsroom-text whitespace-pre-wrap font-sans leading-relaxed">
                  {content}
                </pre>
              )}
            </>
          )}
        </div>

        <div className="px-6 py-3 border-t border-newsroom-border shrink-0">
          <button onClick={onClose} className="btn text-xs">
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

// ── Main ArticleCard ──────────────────────────────────────────────────────────

export const ArticleCard: React.FC<ArticleCardProps> = ({ article, onRefresh }) => {
  const [publishing, setPublishing] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [notesExpanded, setNotesExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Draft modal state
  const [showDraft, setShowDraft] = useState(false);
  const [fullArticle, setFullArticle] = useState<Article | null>(null);
  const [loadingDraft, setLoadingDraft] = useState(false);

  // Inline editor (RED / FAILED only)
  const [editMode, setEditMode] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [saving, setSaving] = useState(false);

  const cfg = STATUS_CONFIG[article.status] ?? STATUS_CONFIG.PROCESSING;
  const pillarColor = PILLAR_COLORS[article.pillar] ?? 'text-newsroom-subtle border-newsroom-border bg-newsroom-muted/10';

  // GREEN articles are already auto-published — never show "Publish to WP"
  const isGreen = article.status === 'GREEN' || article.status === 'PUBLISHED';
  const isRedOrFailed = article.status === 'RED' || article.status === 'FAILED';
  const canManualPublish = article.status === 'YELLOW';
  const canForcePublish = isRedOrFailed;
  const canDiscard = ['YELLOW', 'RED', 'FAILED'].includes(article.status);
  const canEdit = isRedOrFailed;

  async function handlePublish(force = false) {
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

  async function handleViewDraft() {
    setShowDraft(true);
    if (!fullArticle) {
      setLoadingDraft(true);
      try {
        const data = await getArticle(article.id);
        setFullArticle(data);
      } catch {
        // show whatever we have
      } finally {
        setLoadingDraft(false);
      }
    }
  }

  function handleStartEdit() {
    setEditContent(fullArticle?.content || '');
    setEditMode(true);
  }

  async function handleSaveEdit() {
    if (!editContent.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await updateArticleContent(article.id, editContent);
      setFullArticle(updated);
      setEditMode(false);
      onRefresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  // Fetch full article for editing if not yet loaded
  async function ensureFullArticle() {
    if (!fullArticle) {
      try {
        const data = await getArticle(article.id);
        setFullArticle(data);
        setEditContent(data.content || '');
      } catch {
        setEditContent('');
      }
    } else {
      setEditContent(fullArticle.content || '');
    }
    setEditMode(true);
  }

  const featuredImage = article.images?.find((img) => img.isFeatured);

  return (
    <>
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
              <span className={`status-badge border ${cfg.labelClass}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot} inline-block`} />
                {cfg.label}
              </span>
              <span className={`status-badge border ${pillarColor}`}>
                {PILLAR_LABELS[article.pillar]}
              </span>
            </div>
            {article.revisionCount > 0 && (
              <span className="text-xs font-mono text-newsroom-subtle whitespace-nowrap">
                {article.revisionCount} rev{article.revisionCount !== 1 ? 's' : ''}
              </span>
            )}
          </div>

          {/* Title — clickable to open draft */}
          <button
            onClick={handleViewDraft}
            className="text-left w-full text-sm font-semibold text-newsroom-text leading-snug hover:text-newsroom-blue transition-colors"
          >
            {article.title}
          </button>

          {/* Timestamp */}
          <p className="text-xs text-newsroom-subtle font-mono">
            {formatDate(article.createdAt)}
          </p>

          {/* Editor notes (RED articles) */}
          {article.status === 'RED' && article.editorNotes && (
            <div className="bg-newsroom-red/10 border border-newsroom-red/20 rounded p-2.5">
              <p className="text-xs font-mono text-newsroom-subtle mb-1">Editor Notes:</p>
              <p className={`text-xs text-newsroom-text leading-relaxed ${notesExpanded ? '' : 'line-clamp-3'}`}>
                {article.editorNotes}
              </p>
              {article.editorNotes.length > 150 && (
                <button
                  onClick={() => setNotesExpanded(!notesExpanded)}
                  className="text-xs text-newsroom-blue mt-1 hover:underline"
                >
                  {notesExpanded ? 'Show less' : 'Show more'}
                </button>
              )}
            </div>
          )}

          {/* YELLOW editor notes */}
          {article.status === 'YELLOW' && article.editorNotes && (
            <div className="bg-newsroom-yellow/5 border border-newsroom-yellow/20 rounded p-2.5">
              <p className="text-xs font-mono text-newsroom-subtle mb-1">Passed after revision:</p>
              <p className={`text-xs text-newsroom-text leading-relaxed ${notesExpanded ? '' : 'line-clamp-2'}`}>
                {article.editorNotes}
              </p>
              {article.editorNotes.length > 100 && (
                <button
                  onClick={() => setNotesExpanded(!notesExpanded)}
                  className="text-xs text-newsroom-blue mt-1 hover:underline"
                >
                  {notesExpanded ? 'Show less' : 'Show more'}
                </button>
              )}
            </div>
          )}

          {/* GREEN / PUBLISHED: View on WordPress link only — NO publish button */}
          {isGreen && article.wpPostUrl && (
            <a
              href={article.wpPostUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-xs text-newsroom-green hover:underline font-mono"
            >
              <span>↗</span> View on WordPress
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

          {/* Inline editor for RED / FAILED */}
          {canEdit && editMode && (
            <div className="space-y-2">
              <textarea
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
                rows={10}
                className="w-full bg-newsroom-bg border border-newsroom-border rounded-md px-3 py-2 text-xs text-newsroom-text font-mono resize-y focus:outline-none focus:border-newsroom-blue/50"
                placeholder="Edit article content (Markdown)..."
              />
              <div className="flex gap-2">
                <button
                  onClick={handleSaveEdit}
                  disabled={saving}
                  className="btn-primary text-xs flex-1 justify-center"
                >
                  {saving ? 'Saving...' : 'Save Changes'}
                </button>
                <button
                  onClick={() => setEditMode(false)}
                  className="btn text-xs"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="flex flex-wrap gap-2 pt-1">
            {/* View Draft — all statuses except PROCESSING */}
            {article.status !== 'PROCESSING' && (
              <button
                onClick={handleViewDraft}
                className="btn text-xs"
              >
                View Draft
              </button>
            )}

            {/* YELLOW: Publish to WP (requires human approval) */}
            {canManualPublish && (
              <button
                onClick={() => handlePublish(false)}
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

            {/* RED / FAILED: Edit + Force Publish + Discard */}
            {canEdit && !editMode && (
              <button
                onClick={ensureFullArticle}
                className="btn text-xs"
              >
                Edit Content
              </button>
            )}
            {canForcePublish && (
              <button
                onClick={() => handlePublish(true)}
                disabled={publishing}
                className="btn text-xs border-newsroom-red/40 text-newsroom-red hover:bg-newsroom-red/10"
              >
                {publishing ? 'Publishing...' : 'Force Publish'}
              </button>
            )}
            {canDiscard && (
              <button
                onClick={handleDiscard}
                disabled={discarding}
                className="btn-danger text-xs"
              >
                {discarding ? 'Discarding...' : 'Discard'}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Draft modal */}
      {showDraft && (
        <DraftModal
          article={article}
          fullArticle={fullArticle}
          loading={loadingDraft}
          onClose={() => setShowDraft(false)}
        />
      )}
    </>
  );
};
