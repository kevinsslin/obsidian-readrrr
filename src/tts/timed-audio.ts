import type { Token } from "../core/types";
import type { Clock } from "../reader/clock";
import { systemClock } from "../reader/clock";
import type { TtsEvents, TtsSession, SpeakOptions } from "./types";
import { buildUtterances, charIndexToRelToken, type Utterance } from "./chunker";

/**
 * Shared playback engine for cloud TTS providers that return an audio file
 * plus word timings (Unreal Speech today; the same shape fits ElevenLabs and
 * Azure later). A provider adapter supplies `synthesize(text)`; this engine
 * chunks the tokens, plays each chunk through one reused audio element, and
 * fires `onWordSpoken` from the timing table against `audio.currentTime`.
 *
 * Compared to Web Speech this sync is deterministic: the timings are known up
 * front, so the display follows the voice even where boundary events would
 * never fire. WPM maps to `playbackRate` (browsers pitch-correct), so speed
 * changes never require re-synthesis.
 */

/** What a provider adapter returns for one chunk of text. */
export interface SynthesizedChunk {
  /** Encoded audio bytes (e.g. MP3). */
  data: ArrayBuffer;
  mimeType: string;
  /** Spoken-order timings; textOffset is the optional input character offset. */
  words: Array<{ text: string; startSec: number; textOffset?: number }>;
}

/**
 * Map provider word timings onto relative token indices by walking the chunk
 * text with a cursor. Timing entries that cannot be located (engine-side text
 * normalization) are dropped; the next mapped word or chunk transition resumes
 * synchronization.
 */
export function mapWordsToTokens(
  utterance: Utterance,
  words: Array<{ text: string; startSec: number; textOffset?: number }>,
): Array<{ relToken: number; startSec: number }> {
  const out: Array<{ relToken: number; startSec: number }> = [];
  let charCursor = 0;
  let tokenCursor = 0;
  const tokenTexts = utterance.charStarts.map((start, i) => {
    const end = utterance.charStarts[i + 1] ?? utterance.text.length;
    return utterance.text.slice(start, end).trim();
  });
  const normalize = (text: string) =>
    (text.normalize("NFKC").toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join("");

  for (const word of words) {
    const text = word.text.trim();
    if (!text) continue;

    // Prefer the provider's original input offset when available. Spoken text can
    // match a later literal token (for example, input `1 one` spoken as `one one`),
    // while textOffset still points to the correct source token.
    const textOffset = word.textOffset;
    if (
      typeof textOffset === "number" &&
      Number.isInteger(textOffset) &&
      textOffset >= 0 &&
      textOffset < utterance.text.length
    ) {
      const relToken = charIndexToRelToken(utterance.charStarts, textOffset);
      if (relToken >= Math.max(0, tokenCursor - 1)) {
        charCursor = Math.max(charCursor, textOffset + 1);
        tokenCursor = Math.max(tokenCursor, relToken + 1);
        out.push({ relToken, startSec: word.startSec });
        continue;
      }
    }

    // Preserve the exact spoken/input relationship when no offset is available.
    // Repeated words remain ordered because each search starts after the prior hit.
    const at = utterance.text.indexOf(text, charCursor);
    if (at >= 0) {
      charCursor = at + text.length;
      const relToken = charIndexToRelToken(utterance.charStarts, at);
      tokenCursor = relToken + 1;
      out.push({ relToken, startSec: word.startSec });
      continue;
    }

    // Engines sometimes omit punctuation or normalize Unicode in their timing
    // JSON ("Hello" for input "Hello,"). Match normalized tokens in order so
    // those harmless transformations do not throw away word sync.
    const normalized = normalize(text);
    if (!normalized) continue;
    for (let i = tokenCursor; i < tokenTexts.length; i++) {
      if (normalize(tokenTexts[i]) !== normalized) continue;
      tokenCursor = i + 1;
      charCursor = utterance.charStarts[i] + tokenTexts[i].length;
      out.push({ relToken: i, startSec: word.startSec });
      break;
    }
  }
  return out;
}

/**
 * Minimal shape of an `HTMLAudioElement`, narrowed to what the engine uses so
 * playback can be faked in tests. One element is reused for every chunk in a
 * session (`src` swaps per chunk): on iOS an element unlocked by the user
 * gesture that started playback stays playable, while a fresh element per
 * chunk might not be.
 */
export interface AudioLike {
  src: string;
  currentTime: number;
  playbackRate: number;
  volume: number;
  preservesPitch: boolean;
  play(): Promise<void>;
  pause(): void;
  onended: (() => void) | null;
  onerror: (() => void) | null;
}

export interface TimedAudioDeps {
  clock?: Clock;
  createAudio?: () => AudioLike;
  toObjectUrl?: (data: ArrayBuffer, mimeType: string) => string;
  revokeObjectUrl?: (url: string) => void;
}

/** Fire a word once the clock is within this of its start (scheduling jitter). */
const EPSILON_SEC = 0.02;
/** Never poll faster than this while waiting on a stalled/buffering stream. */
const MIN_TICK_MS = 25;
/** Avoid parking exact-timestamp reading forever on a stalled network request. */
const DEFAULT_SYNTHESIS_TIMEOUT_MS = 30_000;
/** Tiny silent WAV used to unlock the reused media element during the user tap. */
const PRIME_AUDIO_URL =
  "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAAABkYXRhBAAAAAAA";

export interface TimedAudioSessionConfig {
  tokens: Token[];
  opts: SpeakOptions;
  events: TtsEvents;
  /** Provider-specific chunk sizing; SpeakOptions remains the default. */
  maxTokensPerChunk?: number;
  /** Combine short sentences until this much text has accumulated. */
  minCharsPerChunk?: number;
  /** Optional provider request limit, applied without splitting a token. */
  maxCharsPerChunk?: number;
  /** Number of chunks that must be ready before the first audio starts. */
  initialBufferChunks?: number;
  /** Number of future chunks to keep synthesized while audio plays. */
  prefetchChunks?: number;
  /** Fail a stalled synthesis instead of freezing the exact-timestamp display. */
  synthesisTimeoutMs?: number;
  /** Provider adapter: turn chunk text into audio + word timings. */
  synthesize(text: string): Promise<SynthesizedChunk>;
  /** Drop this exact provider cache entry when its request stalls. */
  invalidateSynthesis?(text: string, pending: Promise<SynthesizedChunk>): void;
}

export class TimedAudioSession implements TtsSession {
  private readonly clock: Clock;
  private readonly createAudio: () => AudioLike;
  private readonly toObjectUrl: (data: ArrayBuffer, mimeType: string) => string;
  private readonly revokeObjectUrl: (url: string) => void;
  private readonly config: TimedAudioSessionConfig;

  private readonly utterances: Utterance[];
  private readonly startTokenIndex: number;
  private readonly startChunkIndex: number;
  private audio: AudioLike | null = null;
  private currentUrl: string | null = null;
  /** True only while currentUrl is the active, resumable chunk source. */
  private sourceReady = false;
  private chunkIndex = 0;
  private chunkWords: Array<{ relToken: number; startSec: number }> = [];
  private wordPtr = 0;
  private lastEmittedToken = -1;
  private pendingSentenceStart: number | null = null;
  private prefetched = new Map<number, Promise<SynthesizedChunk>>();
  private timer: number | null = null;
  private stopped = false;
  private pausedByUser = false;

  constructor(config: TimedAudioSessionConfig, deps: TimedAudioDeps = {}) {
    this.config = config;
    this.clock = deps.clock ?? systemClock;
    this.createAudio =
      deps.createAudio ?? (() => new Audio() as unknown as AudioLike);
    this.toObjectUrl =
      deps.toObjectUrl ??
      ((data, mimeType) => URL.createObjectURL(new Blob([data], { type: mimeType })));
    this.revokeObjectUrl = deps.revokeObjectUrl ?? ((url) => URL.revokeObjectURL(url));
    this.utterances = buildUtterances(config.tokens, {
      maxTokensPerChunk: config.maxTokensPerChunk ?? config.opts.maxTokensPerChunk,
      minCharsPerChunk: config.minCharsPerChunk,
      maxCharsPerChunk: config.maxCharsPerChunk,
    });
    this.startTokenIndex = Math.max(
      0,
      Math.min(config.tokens.length - 1, config.opts.startTokenIndex ?? 0),
    );
    this.startChunkIndex = Math.max(
      0,
      this.utterances.findIndex(
        (utterance) =>
          this.startTokenIndex >= utterance.tokenStart &&
          this.startTokenIndex < utterance.tokenStart + utterance.tokenCount,
      ),
    );
    this.lastEmittedToken = this.startTokenIndex - 1;
  }

  /** Begin playback (called once by the provider right after construction). */
  start(): void {
    if (this.utterances.length === 0) {
      this.config.events.onEnd?.();
      return;
    }

    // start() runs inside the user's play/tap handler, before any network await.
    // Prime one muted element now so iOS/WebKit will allow that same element to
    // play the fetched MP3 later, after transient user activation has expired.
    this.audio = this.createAudio();
    const audio = this.audio;
    audio.volume = 0;
    audio.src = PRIME_AUDIO_URL;
    void audio
      .play()
      .then(() => {
        // Synthesis can resolve before this promise. Never pause a real chunk
        // that has already replaced the priming source.
        if (!this.stopped && audio.src === PRIME_AUDIO_URL) {
          audio.pause();
          audio.src = "";
        }
      })
      .catch(() => {
        // Best effort: desktop and permissive webviews need no unlock. A real
        // chunk's play() still reports a useful error if playback is blocked.
      });

    void this.startBuffered();
  }

  pause(): void {
    this.pausedByUser = true;
    this.clearTimer();
    this.audio?.pause();
  }

  resume(): void {
    if (this.stopped || !this.pausedByUser) return;
    this.pausedByUser = false;
    // If synthesis is still pending, playChunk() will start the real source when
    // it arrives. Calling play() on the cleared priming source can reject and
    // incorrectly kill narration during a quick pause/resume.
    if (!this.audio || !this.sourceReady) return;
    void this.audio
      .play()
      .then(() => {
        if (this.stopped || this.pausedByUser) return;
        this.announceSentenceStart();
        this.scheduleNextWord();
      })
      .catch(() => this.fail(new Error("Audio playback failed")));
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.cleanup();
  }

  // ---- internals ----

  private normalizedChunkCount(value: number | undefined, fallback: number, min: number): number {
    const count = value !== undefined && Number.isFinite(value) ? Math.floor(value) : fallback;
    return Math.max(min, count);
  }

  private async startBuffered(): Promise<void> {
    const requested = this.normalizedChunkCount(this.config.initialBufferChunks, 1, 1);
    const count = Math.min(requested, this.utterances.length - this.startChunkIndex);
    try {
      await Promise.all(
        Array.from({ length: count }, (_, offset) =>
          this.synthesizeChunk(this.startChunkIndex + offset),
        ),
      );
    } catch (err) {
      this.fail(err instanceof Error ? err : new Error("Speech synthesis failed"));
      return;
    }
    if (this.stopped) return;
    void this.playChunk(this.startChunkIndex);
  }

  private withSynthesisTimeout(
    text: string,
    pending: Promise<SynthesizedChunk>,
  ): Promise<SynthesizedChunk> {
    const timeoutMs = Math.max(
      1,
      this.config.synthesisTimeoutMs ?? DEFAULT_SYNTHESIS_TIMEOUT_MS,
    );
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = this.clock.setTimeout(() => {
        if (settled) return;
        settled = true;
        this.config.invalidateSynthesis?.(text, pending);
        reject(new Error("Speech synthesis timed out"));
      }, timeoutMs);
      pending.then(
        (chunk) => {
          if (settled) return;
          settled = true;
          this.clock.clearTimeout(timer);
          resolve(chunk);
        },
        (err: unknown) => {
          if (settled) return;
          settled = true;
          this.clock.clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  private synthesizeChunk(index: number): Promise<SynthesizedChunk> {
    let pending = this.prefetched.get(index);
    if (!pending) {
      const text = this.utterances[index].text;
      pending = this.withSynthesisTimeout(text, this.config.synthesize(text));
      this.prefetched.set(index, pending);
    }
    return pending;
  }

  private async playChunk(index: number): Promise<void> {
    this.chunkIndex = index;
    let chunk: SynthesizedChunk;
    try {
      chunk = await this.synthesizeChunk(index);
    } catch (err) {
      this.fail(err instanceof Error ? err : new Error("Speech synthesis failed"));
      return;
    }
    if (this.stopped) return;
    // The provider owns the bounded replay cache. Keep only in-flight/current
    // prefetches here so a long book does not retain every audio chunk twice.
    this.prefetched.delete(index);

    // Keep a bounded rolling window ready while this chunk plays. Larger cloud
    // chunks plus lookahead make network latency independent of playback WPM.
    this.warmPrefetchWindow(index);

    const utterance = this.utterances[index];
    this.chunkWords = mapWordsToTokens(utterance, chunk.words);
    this.wordPtr = 0;
    let startSec = 0;
    if (index === this.startChunkIndex && this.startTokenIndex > utterance.tokenStart) {
      const relativeStart = this.startTokenIndex - utterance.tokenStart;
      const firstWord = this.chunkWords.findIndex((word) => word.relToken >= relativeStart);
      if (firstWord >= 0) {
        this.wordPtr = firstWord;
        startSec = this.chunkWords[firstWord].startSec;
      }
    }

    if (this.currentUrl !== null) this.revokeObjectUrl(this.currentUrl);
    this.currentUrl = this.toObjectUrl(chunk.data, chunk.mimeType);

    if (!this.audio) this.audio = this.createAudio();
    const audio = this.audio;
    audio.onended = () => this.onChunkEnded();
    audio.onerror = () => this.fail(new Error("Audio playback error"));
    audio.src = this.currentUrl;
    this.sourceReady = true;
    audio.currentTime = startSec;
    audio.preservesPitch = true;
    audio.playbackRate = this.config.opts.rate;
    audio.volume = this.config.opts.volume;

    if (this.pausedByUser) return; // paused while synthesizing; resume() restarts
    try {
      await audio.play();
    } catch {
      this.fail(new Error("Audio playback failed"));
      return;
    }
    if (this.stopped || this.pausedByUser) return;
    this.announceSentenceStart();
    this.scheduleNextWord();
  }

  private warmPrefetchWindow(currentIndex: number): void {
    const count = this.normalizedChunkCount(this.config.prefetchChunks, 1, 0);
    for (let offset = 1; offset <= count; offset++) {
      const index = currentIndex + offset;
      if (index >= this.utterances.length) break;
      void this.warmPrefetch(index);
    }
  }

  private async warmPrefetch(index: number): Promise<void> {
    try {
      await this.synthesizeChunk(index);
    } catch {
      // Drop the failed prefetch; playChunk retries and reports the error
      // only if it fails again when the chunk is actually needed.
      this.prefetched.delete(index);
    }
  }

  private onChunkEnded(): void {
    if (this.stopped) return;
    this.sourceReady = false;
    this.clearTimer();
    // Words scheduled but not yet fired at chunk end have been spoken; let the
    // sentence-end resync cover them rather than replaying stale snaps.
    const next = this.chunkIndex + 1;
    if (next < this.utterances.length) {
      // Announce the next sentence only after its audio source actually starts.
      // A failed prefetch may need a retry, and the display must not jump ahead
      // while that network request is still pending.
      this.pendingSentenceStart = this.utterances[next].tokenStart;
      void this.playChunk(next);
    } else {
      this.stopped = true;
      this.cleanup();
      this.config.events.onEnd?.();
    }
  }

  private announceSentenceStart(): void {
    if (this.pendingSentenceStart === null) return;
    const nextToken = this.pendingSentenceStart;
    this.pendingSentenceStart = null;
    this.config.events.onSentenceEnd?.(nextToken);
  }

  /**
   * Emit every word whose start time has passed, then sleep until the next
   * one. Delays are recomputed from `audio.currentTime` on every fire, so the
   * schedule self-corrects for buffering stalls and rate changes.
   */
  private scheduleNextWord(): void {
    this.clearTimer();
    if (this.stopped || this.pausedByUser || !this.audio) return;
    const audio = this.audio;

    while (
      this.wordPtr < this.chunkWords.length &&
      this.chunkWords[this.wordPtr].startSec <= audio.currentTime + EPSILON_SEC
    ) {
      const word = this.chunkWords[this.wordPtr];
      this.wordPtr++;
      const absToken = this.utterances[this.chunkIndex].tokenStart + word.relToken;
      // Only ever snap forward; ties and regressions add churn without value.
      if (absToken > this.lastEmittedToken) {
        this.lastEmittedToken = absToken;
        this.config.events.onWordSpoken?.(absToken);
        if (this.stopped) return; // a listener may have stopped us re-entrantly
      }
    }
    if (this.wordPtr >= this.chunkWords.length) return; // rest handled by onended

    const rate = audio.playbackRate > 0 ? audio.playbackRate : 1;
    const waitSec = (this.chunkWords[this.wordPtr].startSec - audio.currentTime) / rate;
    this.timer = this.clock.setTimeout(
      () => {
        this.timer = null;
        this.scheduleNextWord();
      },
      Math.max(MIN_TICK_MS, waitSec * 1000),
    );
  }

  private fail(err: Error): void {
    if (this.stopped) return;
    this.stopped = true;
    this.cleanup();
    this.config.events.onError?.(err);
  }

  private cleanup(): void {
    this.clearTimer();
    if (this.audio) {
      this.audio.onended = null;
      this.audio.onerror = null;
      this.audio.pause();
      this.audio.src = "";
    }
    if (this.currentUrl !== null) {
      this.revokeObjectUrl(this.currentUrl);
      this.currentUrl = null;
    }
    this.sourceReady = false;
    this.pendingSentenceStart = null;
    this.prefetched.clear();
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      this.clock.clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
