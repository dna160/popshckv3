import type { Pillar } from './types';

export interface VoiceProfile {
  voiceId:     string;
  character:   string;
  gender:      'M' | 'F';
  personality: string;
}

// Voice IDs are sourced from ElevenLabs. Store actual clone IDs in env vars
// after recording reference audio per §11.2. These defaults use ElevenLabs
// multilingual stock voices until clones are ready.
export const VOICE_PROFILES: Record<Pillar, VoiceProfile> = {
  anime: {
    voiceId:     process.env.ELEVENLABS_VOICE_ANIME     || 'pFZP5JQG7iQjIQuC4Bku',
    character:   'Sakura',
    gender:      'F',
    personality: 'Girly fangirl, high-pitched, kyaa~, sugoi!',
  },
  gaming: {
    voiceId:     process.env.ELEVENLABS_VOICE_GAMING    || 'N2lVS1w4EtoT3dr4eOWO',
    character:   'Ryuji',
    gender:      'M',
    personality: 'Discord bro, hyped, gas, gg, goks',
  },
  manga: {
    voiceId:     process.env.ELEVENLABS_VOICE_MANGA     || 'XB0fDUnXU5powFXDhCwa',
    character:   'Hana',
    gender:      'F',
    personality: 'Soft, warm, storytelling, wah, keren banget',
  },
  infotainment: {
    voiceId:     process.env.ELEVENLABS_VOICE_INFOTAINMENT || 'EXAVITQu4vr4xnSDxMaL',
    character:   'Maya',
    gender:      'F',
    personality: 'Professional anchor, measured, authoritative',
  },
  toys: {
    voiceId:     process.env.ELEVENLABS_VOICE_TOYS      || 'TX3LPaxmHKxFdv7VOQHJ',
    character:   'Kenji',
    gender:      'M',
    personality: 'Collector bro, excited, woi, cuy, mantap',
  },
};
