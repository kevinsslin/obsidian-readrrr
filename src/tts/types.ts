import type { Token } from "../core/types";

/** A voice the user can pick, normalized across providers. */
export interface TtsVoice {
  id: string;
  label: string;
  lang: string;
  /** True for on-device voices (which fire word-boundary events reliably). */
  localService: boolean;
  isDefault: boolean;
}

export interface SpeakOptions {
  /** Voice id (provider-specific); null uses the engine default. */
  voiceId?: string | null;
  /** Playback rate (Web Speech scale: 1 = normal). */
  rate: number;
  pitch: number;
  volume: number;
  /** Cap tokens per spoken chunk so long paragraphs still resync often. */
  maxTokensPerChunk?: number;
}

export const DEFAULT_SPEAK_OPTIONS: SpeakOptions = {
  voiceId: null,
  rate: 1,
  pitch: 1,
  volume: 1,
  maxTokensPerChunk: 40,
};

/**
 * Events a provider emits during playback. Token indices are RELATIVE to the
 * token array passed to `speak()` (0-based within that array); the Reader adds
 * its own start offset. The Reader consumes these to keep the display in sync
 * with audio.
 */
export interface TtsEvents {
  /** Word-boundary fired for this (relative) token; fine sync, may not fire. */
  onWordSpoken?(tokenIndex: number): void;
  /** A spoken chunk finished; the next chunk starts at this (relative) token. */
  onSentenceEnd?(nextTokenIndex: number): void;
  /** All chunks finished. */
  onEnd?(): void;
  onError?(err: Error): void;
}

export interface TtsSession {
  pause(): void;
  resume(): void;
  stop(): void;
}

export interface TtsProvider {
  readonly id: string;
  readonly name: string;
  isAvailable(): boolean;
  listVoices(): TtsVoice[];
  speak(tokens: Token[], opts: SpeakOptions, events: TtsEvents): TtsSession;
}

/**
 * Minimal shape of `window.speechSynthesis`, narrowed to what we use so it can
 * be injected/faked in tests.
 */
export interface SpeechSynthesisLike {
  speak(utterance: SpeechUtteranceLike): void;
  cancel(): void;
  pause(): void;
  resume(): void;
  getVoices(): SpeechSynthesisVoice[];
}

/** Minimal shape of `SpeechSynthesisUtterance`, injectable for tests. */
export interface SpeechUtteranceLike {
  text: string;
  rate: number;
  pitch: number;
  volume: number;
  voice: SpeechSynthesisVoice | null;
  onboundary: ((ev: { charIndex: number; name?: string }) => void) | null;
  onend: (() => void) | null;
  onerror: ((ev: unknown) => void) | null;
}
