const POLL_INTERVAL_MS = 3_000;
const POLL_TIMEOUT_MS  = 5 * 60 * 1_000;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`[GrokClient] Missing env var: ${name}`);
  return v;
}

async function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Submit an image-to-video job to Grok Imagine, poll until done,
 * then download the result immediately (URLs are ephemeral).
 */
export async function generateVideo(input: {
  imageUrl:    string;
  prompt:      string;
  durationSec: number;
  aspectRatio: '9:16' | '16:9' | '1:1';
  resolution:  '480p' | '720p';
}): Promise<Buffer> {
  const apiKey = requireEnv('XAI_API_KEY');

  // 1. Submit
  console.log(`[GrokClient] Submitting I2V job: duration=${input.durationSec}s prompt="${input.prompt.slice(0, 60)}..."`);
  const submitRes = await fetch('https://api.x.ai/v1/videos/generations', {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      model:        'grok-imagine-video',
      prompt:       input.prompt,
      image:        { url: input.imageUrl },
      duration:     input.durationSec,
      aspect_ratio: input.aspectRatio,
      resolution:   input.resolution,
    }),
  });

  if (!submitRes.ok) {
    const err = await submitRes.text();
    throw new Error(`[GrokClient] Submit failed (${submitRes.status}): ${err}`);
  }

  const { request_id } = (await submitRes.json()) as { request_id: string };
  console.log(`[GrokClient] Job submitted request_id=${request_id}`);

  // 2. Poll
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const statusRes = await fetch(`https://api.x.ai/v1/videos/${request_id}`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });

    if (!statusRes.ok) {
      console.warn(`[GrokClient] Poll returned ${statusRes.status}, retrying...`);
      continue;
    }

    const data = (await statusRes.json()) as {
      status: string;
      video?: { url: string };
    };

    console.log(`[GrokClient] Poll status=${data.status} request_id=${request_id}`);

    if (data.status === 'done' && data.video?.url) {
      // 3. Download immediately — URL is ephemeral
      const vidRes = await fetch(data.video.url);
      if (!vidRes.ok) throw new Error(`[GrokClient] Video download failed (${vidRes.status})`);
      return Buffer.from(await vidRes.arrayBuffer());
    }

    if (data.status === 'error' || data.status === 'failed') {
      throw new Error(`[GrokClient] Job failed: ${JSON.stringify(data)}`);
    }
  }

  throw new Error(`[GrokClient] Polling timeout (5 min) for request_id=${request_id}`);
}
