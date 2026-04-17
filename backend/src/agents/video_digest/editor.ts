import { chat, parseJsonResponse } from '../../services/llm';
import { EDITOR_SYSTEM_PROMPT, buildEditorPrompt } from './prompts/editor_system';
import type { Storyboard, EditorVerdict, ArticleRecord } from './types';

const VALID_SEVERITIES = new Set(['pass', 'minor', 'major', 'block']);

function validateVerdict(obj: unknown): EditorVerdict {
  const v = obj as EditorVerdict;
  if (typeof v.approved !== 'boolean') throw new Error('[Editor] Missing approved field');
  if (!VALID_SEVERITIES.has(v.severity)) {
    throw new Error(`[Editor] Unknown severity: ${v.severity}`);
  }
  return v;
}

export class Editor {
  async review(
    storyboard: Storyboard,
    articles:   ArticleRecord[]
  ): Promise<EditorVerdict> {
    const userPrompt = buildEditorPrompt(storyboard, articles);

    console.log(`[Editor] Reviewing storyboard pillar=${storyboard.pillar} round=${storyboard.revisionRound}`);

    const raw = await chat([
      { role: 'system', content: EDITOR_SYSTEM_PROMPT },
      { role: 'user',   content: userPrompt },
    ], { maxTokens: 1000, temperature: 0.3 });

    const parsed  = parseJsonResponse<unknown>(raw);
    const verdict = validateVerdict(parsed);

    console.log(`[Editor] verdict=${verdict.severity} approved=${verdict.approved}`);
    return verdict;
  }
}
