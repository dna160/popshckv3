// Shared TypeScript types for Synthetic Newsroom POC

export type Pillar =
  | 'anime'
  | 'gaming'
  | 'infotainment'
  | 'manga'
  | 'toys';

export const PILLARS: Pillar[] = ['anime', 'gaming', 'infotainment', 'manga', 'toys'];

export const PILLAR_LABELS: Record<Pillar, string> = {
  anime: 'Japanese Anime',
  gaming: 'Japanese Gaming',
  infotainment: 'Japanese Infotainment',
  manga: 'Japanese Manga',
  toys: 'Japanese Toys/Collectibles',
};

export type ArticleStatus =
  | 'PROCESSING'
  | 'GREEN'
  | 'YELLOW'
  | 'RED'
  | 'FAILED'
  | 'PUBLISHED';

export interface ArticleImage {
  url: string;
  alt: string;
  isFeatured: boolean;
  sourceQuery?: string;
}

export interface Article {
  id: string;
  title: string;
  pillar: Pillar;
  sourceUrl: string;
  status: ArticleStatus;
  revisionCount: number;
  content: string | null;
  contentHtml: string | null;
  images: ArticleImage[] | null;
  editorNotes: string | null;
  wpPostId: number | null;
  wpPostUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export type PipelineRunStatus = 'RUNNING' | 'COMPLETED' | 'FAILED';

export interface PipelineLogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  agent?: string;
  articleId?: string;
  reasoning?: string;
  fallback_taken?: string;
}

export interface PipelineRun {
  id: string;
  status: PipelineRunStatus;
  articlesProcessed: number;
  startedAt: string;
  completedAt: string | null;
  logs: PipelineLogEntry[] | null;
}

export interface ScoutItem {
  title: string;
  link: string;
  summary: string;
  pillar: Pillar;
  rawContent?: string;
  translationNotes?: string;
}

export interface ResearchedItem extends ScoutItem {
  images: ArticleImage[];
  facts: string[];
  approved: boolean;
  rejectionReason?: string;
}

export interface DraftArticle {
  title: string;
  pillar: Pillar;
  sourceUrl: string;
  content: string;
  images: ArticleImage[];
  wordCount: number;
}

export interface EditorResult {
  passed: boolean;
  autoFixed: boolean;
  fixedContent?: string;
  feedback: string;
  issueType?: 'MINOR' | 'MAJOR' | 'IMAGE' | 'UNSALVAGEABLE' | null;
  hallucinations?: string[];
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface PipelineStatusResponse {
  currentRun: PipelineRun | null;
  lastRun: PipelineRun | null;
  isRunning: boolean;
}

export interface DashboardStats {
  total: number;
  green: number;
  yellow: number;
  red: number;
  processing: number;
  published: number;
  failed: number;
  byPillar: Record<Pillar, number>;
}
