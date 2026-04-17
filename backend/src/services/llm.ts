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

// ── Rate limiter: 900 requests per minute (sliding window) ────────────────────

class RateLimiter {
  private queue: Array<() => void> = [];
  private timestamps: number[] = [];
  private readonly maxPerMinute: number;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(maxPerMinute: number) {
    this.maxPerMinute = maxPerMinute;
  }

  acquire(): Promise<void> {
    return new Promise((resolve) => {
      this.queue.push(resolve);
      this.process();
    });
  }

  private process(): void {
    if (this.queue.length === 0) return;

    const now = Date.now();
    const windowStart = now - 60_000;
    this.timestamps = this.timestamps.filter((t) => t > windowStart);

    if (this.timestamps.length < this.maxPerMinute) {
      const resolve = this.queue.shift()!;
      this.timestamps.push(Date.now());
      resolve();
      if (this.queue.length > 0) {
        setImmediate(() => this.process());
      }
    } else {
      // Wait until the oldest timestamp exits the 60s window
      const waitMs = this.timestamps[0] - windowStart + 1;
      if (!this.timer) {
        this.timer = setTimeout(() => {
          this.timer = null;
          this.process();
        }, waitMs);
      }
    }
  }
}

const rateLimiter = new RateLimiter(900);

// ─────────────────────────────────────────────────────────────────────────────

const CHAT_TIMEOUT_MS = 90_000; // 90 seconds — kills hanging API calls

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`LLM request timed out after ${ms}ms (${label})`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Send a chat completion request to Grok via xAI API.
 */
export async function chat(
  messages: ChatMessage[],
  opts: { temperature?: number; maxTokens?: number } = {}
): Promise<string> {
  await rateLimiter.acquire();
  const response = await withTimeout(
    llmClient.chat.completions.create({
      model: MODEL,
      messages: messages as OpenAI.ChatCompletionMessageParam[],
      temperature: opts.temperature ?? 0.7,
      max_tokens: opts.maxTokens ?? 2048,
    }),
    CHAT_TIMEOUT_MS,
    'chat'
  );

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
  // xAI vision API only supports HTTPS image URLs
  if (!imageUrl.startsWith('https://')) return false;

  try {
    await rateLimiter.acquire();
    const response = await withTimeout(llmClient.chat.completions.create({
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
    }), CHAT_TIMEOUT_MS, 'vision');

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
