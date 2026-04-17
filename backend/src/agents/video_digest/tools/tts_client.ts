export interface TtsResult {
  audioBuffer:  Buffer;
  durationMs:   number;
}

function wrapPcmInWav(pcm: Buffer, sampleRate: number, channels: number): Buffer {
  const byteRate   = sampleRate * channels * 2;
  const dataSize   = pcm.length;
  const header     = Buffer.alloc(44);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);           // PCM chunk size
  header.writeUInt16LE(1, 20);            // PCM format
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(channels * 2, 32); // block align
  header.writeUInt16LE(16, 34);           // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcm]);
}

// ElevenLabs PCM_48000 — 16-bit signed, mono, 48kHz
async function elevenlabs(text: string, voiceId: string): Promise<TtsResult> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error('[TtsClient] Missing ELEVENLABS_API_KEY');

  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=pcm_48000`,
    {
      method:  'POST',
      headers: {
        'xi-api-key':   apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        model_id:       'eleven_multilingual_v2',
        voice_settings: { stability: 0.55, similarity_boost: 0.75 },
      }),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`[TtsClient/ElevenLabs] ${res.status}: ${err}`);
  }

  const pcm        = Buffer.from(await res.arrayBuffer());
  const wav        = wrapPcmInWav(pcm, 48000, 1);
  // 16-bit samples: length / 2 bytes per sample / sampleRate * 1000ms
  const durationMs = Math.round((pcm.length / 2 / 48000) * 1000);

  return { audioBuffer: wav, durationMs };
}

// Fish Audio fallback
async function fishAudio(text: string, voiceId: string): Promise<TtsResult> {
  const apiKey = process.env.FISH_AUDIO_API_KEY;
  if (!apiKey) throw new Error('[TtsClient] Missing FISH_AUDIO_API_KEY');

  const res = await fetch('https://api.fish.audio/v1/tts', {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      text,
      reference_id: voiceId,
      format:       'wav',
      sample_rate:  48000,
      latency:      'normal',
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`[TtsClient/FishAudio] ${res.status}: ${err}`);
  }

  const audioBuffer = Buffer.from(await res.arrayBuffer());
  // WAV header is 44 bytes; 16-bit PCM mono 48kHz after that
  const pcmBytes    = audioBuffer.length - 44;
  const durationMs  = Math.max(0, Math.round((pcmBytes / 2 / 48000) * 1000));

  return { audioBuffer, durationMs };
}

/**
 * Synthesize text to speech. Tries ElevenLabs first, falls back to Fish Audio.
 */
export async function synthesize(
  text:    string,
  voiceId: string
): Promise<TtsResult> {
  try {
    return await elevenlabs(text, voiceId);
  } catch (err) {
    console.warn(`[TtsClient] ElevenLabs failed, trying Fish Audio fallback: ${(err as Error).message}`);
    return await fishAudio(text, voiceId);
  }
}
