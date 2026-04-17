import type { Pillar } from '../../shared/types';

export type { Pillar };

export type SegmentType = 'article' | 'outro';

export interface StoryboardSegment {
  index:           number;
  type:            SegmentType;
  articleId?:      string;
  scriptLine:      string;
  targetDurationMs: number;
  imageUrl?:       string;
  grokPrompt:      string;
  styleTag:        string;
  lowerThirdText:  string;
}

export interface Storyboard {
  pillar:               Pillar;
  segments:             StoryboardSegment[];
  caption:              string;
  targetTotalDurationMs: number;
  revisionRound:        number;
}

export interface EditorVerdict {
  approved:         boolean;
  feedback:         string;
  severity:         'pass' | 'minor' | 'major' | 'block';
  perSegmentNotes?: Record<number, string>;
}

export interface AudioSegment {
  segmentIndex:     number;
  audioBuffer:      Buffer;
  measuredDurationMs: number;
}

export interface VideoSegment {
  segmentIndex:   number;
  videoBuffer:    Buffer;
  actualDurationMs: number;
  source:         'grok' | 'brand_outro';
}

export interface ComposedVideo {
  pillar:          Pillar;
  mp4Buffer:       Buffer;
  caption:         string;
  totalDurationMs: number;
}

export interface PublishResult {
  wpMediaUrl: string;
  reelId:     string | null;
  storyId:    string | null;
  errors:     string[];
}

export interface ArticleRecord {
  id:         string;
  title:      string;
  content:    string | null;
  images:     string | null;
  wpPostUrl:  string | null;
}
