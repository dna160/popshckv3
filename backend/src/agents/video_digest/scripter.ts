import { chat, parseJsonResponse } from '../../services/llm';
import {
  SCRIPTER_SYSTEM_PROMPT,
  buildFirstDraftPrompt,
  buildRevisionPrompt,
} from './prompts/scripter_system';
import type { Pillar, Storyboard, EditorVerdict, ArticleRecord } from './types';

function validateStoryboard(obj: unknown): Storyboard {
  const s = obj as Storyboard;
  if (!s.pillar || !Array.isArray(s.segments) || s.segments.length !== 4) {
    throw new Error('[Scripter] Invalid storyboard: expected 4 segments');
  }
  for (const seg of s.segments) {
    if (typeof seg.index !== 'number' || !seg.type || !seg.scriptLine) {
      throw new Error(`[Scripter] Malformed segment at index ${seg.index}`);
    }
  }
  return s;
}

export class Scripter {
  async draft(input: {
    pillar:            Pillar;
    articles:          ArticleRecord[];
    previousStoryboard: Storyboard | null;
    editorFeedback:    string | undefined;
    round:             number;
  }): Promise<Storyboard> {
    const system = SCRIPTER_SYSTEM_PROMPT(input.pillar);

    const userPrompt = input.round === 0
      ? buildFirstDraftPrompt(input.articles)
      : buildRevisionPrompt(input.previousStoryboard!, input.editorFeedback!, input.round);

    console.log(`[Scripter] pillar=${input.pillar} round=${input.round} — calling LLM`);

    const raw = await chat([
      { role: 'system',  content: system },
      { role: 'user',    content: userPrompt },
    ], { maxTokens: 2000, temperature: 0.7 });

    const parsed = parseJsonResponse<unknown>(raw);
    const storyboard = validateStoryboard(parsed);
    storyboard.revisionRound = input.round;
    return storyboard;
  }
}
