import { synthesize } from './tools/tts_client';
import { VOICE_PROFILES } from './voice_profiles';
import type { Storyboard, AudioSegment } from './types';

export class Voiceover {
  async generate(storyboard: Storyboard): Promise<AudioSegment[]> {
    const profile = VOICE_PROFILES[storyboard.pillar];

    console.log(`[Voiceover] pillar=${storyboard.pillar} voice=${profile.character} segments=${storyboard.segments.length}`);

    const results = await Promise.all(
      storyboard.segments.map(async (seg) => {
        console.log(`[Voiceover] TTS segment ${seg.index}: "${seg.scriptLine.slice(0, 50)}..."`);
        const { audioBuffer, durationMs } = await synthesize(seg.scriptLine, profile.voiceId);
        console.log(`[Voiceover] Segment ${seg.index} measured=${durationMs}ms`);
        return {
          segmentIndex:      seg.index,
          audioBuffer,
          measuredDurationMs: durationMs,
        } as AudioSegment;
      })
    );

    return results.sort((a, b) => a.segmentIndex - b.segmentIndex);
  }
}
