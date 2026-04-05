// Frontend types — mirrors shared/types.ts for the browser bundle

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

export const PILLAR_COLORS: Record<Pillar, string> = {
  anime:        'text-purple-400 border-purple-500/40 bg-purple-500/10',
  gaming:       'text-blue-400   border-blue-500/40   bg-blue-500/10',
  infotainment: 'text-cyan-400   border-cyan-500/40   bg-cyan-500/10',
  manga:        'text-orange-400 border-orange-500/40 bg-orange-500/10',
  toys:         'text-pink-400   border-pink-500/40   bg-pink-500/10',
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

export interface PipelineLogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  agent?: string;
  articleId?: string;
}

export interface PipelineRun {
  id: string;
  status: 'RUNNING' | 'COMPLETED' | 'FAILED';
  articlesProcessed: number;
  startedAt: string;
  completedAt: string | null;
  logs: PipelineLogEntry[] | null;
}

export interface PipelineStatusData {
  isRunning: boolean;
  currentRun: PipelineRun | null;
  lastRun: PipelineRun | null;
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
  publishedByPillar: Record<Pillar, number>;
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}
