import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

if (!process.env.XAI_API_KEY) {
  throw new Error('XAI_API_KEY environment variable is required');
}

export const llmClient = new OpenAI({
  apiKey: process.env.XAI_API_KEY,
  baseURL: 'https://api.x.ai/v1',
});

export const MODEL = 'grok-4-1-fast-reasoning';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | OpenAI.ChatCompletionContentPart[];
}

/**
 * Send a chat completion request to Grok via xAI API.
 */
export async function chat(
  messages: ChatMessage[],
  opts: { temperature?: number; maxTokens?: number } = {}
): Promise<string> {
  const response = await llmClient.chat.completions.create({
    model: MODEL,
    messages: messages as OpenAI.ChatCompletionMessageParam[],
    temperature: opts.temperature ?? 0.7,
    max_tokens: opts.maxTokens ?? 2048,
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error('LLM returned empty response');
  }
  return content.trim();
}

/**
 * Ask Grok to evaluate an image URL for relevance to a topic.
 * Returns YES or NO.
 */
export async function evaluateImageRelevance(
  imageUrl: string,
  topic: string,
  pillar: string
): Promise<boolean> {
  try {
    const response = await llmClient.chat.completions.create({
      model: MODEL,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `You are evaluating whether an image is relevant to an article about "${topic}" in the "${pillar}" content pillar.

Respond with ONLY "YES" if the image is clearly relevant and high quality, or "NO" if it is irrelevant, low quality, or inappropriate.

Image URL: ${imageUrl}`,
            },
            {
              type: 'image_url',
              image_url: { url: imageUrl },
            },
          ],
        },
      ],
      max_tokens: 10,
      temperature: 0,
    });

    const answer = response.choices[0]?.message?.content?.trim().toUpperCase();
    return answer === 'YES';
  } catch (err) {
    // If vision evaluation fails (e.g., image inaccessible), default to false
    console.warn(`Vision evaluation failed for ${imageUrl}:`, err);
    return false;
  }
}

/**
 * Parse a JSON response from the LLM, stripping markdown code blocks if present.
 */
export function parseJsonResponse<T>(raw: string): T {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  return JSON.parse(cleaned) as T;
}
