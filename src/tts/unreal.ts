import type { Token } from "../core/types";
import { clamp } from "./rate";
import type { TtsProvider, TtsSession, TtsEvents, TtsVoice, SpeakOptions } from "./types";
import {
  persistentCacheKey,
  type PersistentNarrationCache,
} from "./persistent-cache";
import {
  TimedAudioSession,
  type SynthesizedChunk,
  type TimedAudioDeps,
} from "./timed-audio";

/**
 * Unreal Speech (unrealspeech.com): the engine behind Readwise Reader's
 * read-aloud. Bring-your-own-API-key; the free tier covers 250K characters.
 *
 * Per chunk, POST /speech with `TimestampType: "word"` returns two CDN URLs:
 * the MP3 and a JSON array of `{ word, start, end, text_offset }`. That timing
 * table is exactly what drives the word-synced RSVP display (see
 * timed-audio.ts). Audio is synthesized at natural pace; WPM maps to the
 * element's playbackRate, so the cache survives speed changes.
 */

export const UNREAL_DEFAULT_BASE_URL = "https://api.v8.unrealspeech.com";
const UNREAL_BITRATE = "128k";
const UNREAL_SPEECH_MIN_CHARS = 800;
const UNREAL_SPEECH_MAX_CHARS = 3_000;
const UNREAL_SPEECH_MAX_TOKENS = 300;
const UNREAL_INITIAL_BUFFER_CHUNKS = 2;
const UNREAL_PREFETCH_CHUNKS = 2;

function voice(id: string, lang: string, description: string, isDefault = false): TtsVoice {
  return {
    id,
    label: `${id} (${description})`,
    lang,
    localService: false,
    isDefault,
  };
}

/** V8's documented voice list (the service does not expose a voices endpoint). */
const UNREAL_VOICES: TtsVoice[] = [
  voice("Sierra", "en-US", "American female", true),
  voice("Autumn", "en-US", "American female"),
  voice("Melody", "en-US", "American female"),
  voice("Hannah", "en-US", "American female"),
  voice("Emily", "en-US", "American female"),
  voice("Ivy", "en-US", "American female"),
  voice("Kaitlyn", "en-US", "American female"),
  voice("Luna", "en-US", "American female"),
  voice("Willow", "en-US", "American female"),
  voice("Lauren", "en-US", "American female"),
  voice("Noah", "en-US", "American male"),
  voice("Jasper", "en-US", "American male"),
  voice("Caleb", "en-US", "American male"),
  voice("Ronan", "en-US", "American male"),
  voice("Ethan", "en-US", "American male"),
  voice("Daniel", "en-US", "American male"),
  voice("Zane", "en-US", "American male"),
  voice("Mei", "zh-CN", "Chinese female"),
  voice("Lian", "zh-CN", "Chinese female"),
  voice("Ting", "zh-CN", "Chinese female"),
  voice("Jing", "zh-CN", "Chinese female"),
  voice("Wei", "zh-CN", "Chinese male"),
  voice("Jian", "zh-CN", "Chinese male"),
  voice("Hao", "zh-CN", "Chinese male"),
  voice("Sheng", "zh-CN", "Chinese male"),
  voice("Lucía", "es-ES", "Spanish female"),
  voice("Mateo", "es-ES", "Spanish male"),
  voice("Javier", "es-ES", "Spanish male"),
  voice("Élodie", "fr-FR", "French female"),
  voice("Ananya", "hi-IN", "Hindi female"),
  voice("Priya", "hi-IN", "Hindi female"),
  voice("Arjun", "hi-IN", "Hindi male"),
  voice("Rohan", "hi-IN", "Hindi male"),
  voice("Giulia", "it-IT", "Italian female"),
  voice("Luca", "it-IT", "Italian male"),
  voice("Camila", "pt-BR", "Portuguese female"),
  voice("Thiago", "pt-BR", "Portuguese male"),
  voice("Rafael", "pt-BR", "Portuguese male"),
];

const NOOP_SESSION: TtsSession = {
  pause() {},
  resume() {},
  stop() {},
};

export interface UnrealSpeechConfig {
  apiKey: string;
  baseUrl?: string;
}

/**
 * The three HTTP shapes the provider needs, injectable so main.ts can back
 * them with Obsidian's `requestUrl` (no CORS on desktop or mobile) and tests
 * can fake the network entirely.
 */
export interface UnrealHttp {
  postJson(url: string, headers: Record<string, string>, body: unknown): Promise<unknown>;
  getJson(url: string): Promise<unknown>;
  getBinary(url: string): Promise<ArrayBuffer>;
}

interface SpeechResponse {
  OutputUri?: string;
  TimestampsUri?: string;
}

interface TimestampEntry {
  word?: string;
  start?: number;
  end?: number;
  text_offset?: number;
}

/** Bound unresolved requests even though requestUrl itself cannot cancel them. */
const MEMORY_CACHE_MAX_ENTRIES = 32;
const DEFAULT_MEMORY_CACHE_LIMIT_BYTES = 32_000_000;

interface MemoryCacheEntry {
  pending: Promise<SynthesizedChunk>;
  sizeBytes: number;
  generation: number;
}

function chunkSizeBytes(chunk: SynthesizedChunk): number {
  return chunk.data.byteLength + new TextEncoder().encode(JSON.stringify(chunk.words)).byteLength;
}

export class UnrealSpeechProvider implements TtsProvider {
  readonly id = "unreal-speech";
  readonly name = "Unreal Speech";
  readonly exactWordTimings = true;

  private readonly getConfig: () => UnrealSpeechConfig;
  private readonly http: UnrealHttp;
  private readonly audioDeps: TimedAudioDeps;
  private readonly persistentCache: PersistentNarrationCache | null;
  private readonly memoryCacheLimitBytes: number;
  /** Plugin-session byte-bounded LRU, keyed by bitrate/voice/pitch/text. */
  private readonly cache = new Map<string, MemoryCacheEntry>();
  private memoryCacheBytes = 0;
  private cacheGeneration = 0;
  private activeSession: TtsSession | null = null;

  constructor(
    getConfig: () => UnrealSpeechConfig,
    http: UnrealHttp,
    audioDeps: TimedAudioDeps = {},
    persistentCache: PersistentNarrationCache | null = null,
    memoryCacheLimitBytes = DEFAULT_MEMORY_CACHE_LIMIT_BYTES,
  ) {
    this.getConfig = getConfig;
    this.http = http;
    this.audioDeps = audioDeps;
    this.persistentCache = persistentCache;
    this.memoryCacheLimitBytes = Number.isFinite(memoryCacheLimitBytes)
      ? Math.max(0, Math.floor(memoryCacheLimitBytes))
      : DEFAULT_MEMORY_CACHE_LIMIT_BYTES;
  }

  isAvailable(): boolean {
    return this.getConfig().apiKey.trim().length > 0;
  }

  listVoices(): TtsVoice[] {
    return UNREAL_VOICES;
  }

  /** Clear replay memory and invalidate persistent writes started before this call. */
  clearCache(): void {
    this.cacheGeneration++;
    this.cache.clear();
    this.memoryCacheBytes = 0;
  }

  speak(tokens: Token[], opts: SpeakOptions, events: TtsEvents): TtsSession {
    // Supersede any previous run so its late callbacks cannot interleave.
    this.activeSession?.stop();
    this.activeSession = null;
    if (!this.isAvailable()) {
      events.onError?.(new Error("Unreal Speech: no API key configured"));
      return NOOP_SESSION;
    }
    if (tokens.length === 0) {
      events.onEnd?.();
      return NOOP_SESSION;
    }

    const voiceId = this.resolveVoiceId(opts.voiceId);
    const pitch = clamp(opts.pitch, 0.5, 1.5);
    const state: { timed: TimedAudioSession | null } = { timed: null };
    const session: TtsSession = {
      pause: () => state.timed?.pause(),
      resume: () => state.timed?.resume(),
      stop: () => {
        const timed = state.timed;
        state.timed = null;
        timed?.stop();
        if (this.activeSession === session) this.activeSession = null;
      },
    };
    const clearActive = () => {
      state.timed = null;
      if (this.activeSession === session) this.activeSession = null;
    };
    const timed = new TimedAudioSession(
      {
        tokens,
        opts,
        events: {
          ...events,
          onEnd: () => {
            clearActive();
            events.onEnd?.();
          },
          onError: (err) => {
            clearActive();
            events.onError?.(err);
          },
        },
        maxTokensPerChunk: UNREAL_SPEECH_MAX_TOKENS,
        minCharsPerChunk: UNREAL_SPEECH_MIN_CHARS,
        maxCharsPerChunk: UNREAL_SPEECH_MAX_CHARS,
        initialBufferChunks: UNREAL_INITIAL_BUFFER_CHUNKS,
        prefetchChunks: UNREAL_PREFETCH_CHUNKS,
        synthesize: (text) => this.synthesize(text, voiceId, pitch),
        invalidateSynthesis: (text, pending) => {
          const key = this.cacheKey(text, voiceId, pitch);
          const entry = this.cache.get(key);
          if (entry?.pending === pending) this.removeCacheEntry(key, entry);
        },
      },
      this.audioDeps,
    );
    state.timed = timed;
    this.activeSession = session;
    timed.start();
    return session;
  }

  private resolveVoiceId(voiceId: string | null | undefined): string {
    if (voiceId && UNREAL_VOICES.some((v) => v.id === voiceId)) return voiceId;
    return UNREAL_VOICES[0].id;
  }

  private cacheKey(text: string, voiceId: string, pitch: number): string {
    return `${UNREAL_BITRATE}|${voiceId}|${pitch}|${text}`;
  }

  private synthesize(text: string, voiceId: string, pitch: number): Promise<SynthesizedChunk> {
    const key = this.cacheKey(text, voiceId, pitch);
    const cached = this.cache.get(key);
    if (cached) {
      // Refresh recency: Map iteration order is insertion order, so re-insert.
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached.pending;
    }

    const generation = this.cacheGeneration;
    const pending = this.loadPersistentOrFetch(text, voiceId, pitch, generation);
    const entry: MemoryCacheEntry = { pending, sizeBytes: 0, generation };
    this.cache.set(key, entry);
    pending.then(
      (chunk) => {
        if (this.cache.get(key) !== entry || generation !== this.cacheGeneration) return;
        entry.sizeBytes = chunkSizeBytes(chunk);
        this.memoryCacheBytes += entry.sizeBytes;
        this.trimMemoryCache();
      },
      () => {
        if (this.cache.get(key) === entry) this.removeCacheEntry(key, entry);
      },
    );
    this.trimMemoryCache();
    return pending;
  }

  private removeCacheEntry(key: string, entry: MemoryCacheEntry): void {
    if (this.cache.get(key) !== entry) return;
    this.cache.delete(key);
    this.memoryCacheBytes = Math.max(0, this.memoryCacheBytes - entry.sizeBytes);
  }

  private trimMemoryCache(): void {
    while (
      this.cache.size > MEMORY_CACHE_MAX_ENTRIES ||
      this.memoryCacheBytes > this.memoryCacheLimitBytes
    ) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = this.cache.get(oldestKey);
      if (!oldest) break;
      this.removeCacheEntry(oldestKey, oldest);
    }
  }

  private async loadPersistentOrFetch(
    text: string,
    voiceId: string,
    pitch: number,
    generation: number,
  ): Promise<SynthesizedChunk> {
    let key: string | null = null;
    if (this.persistentCache) {
      try {
        key = await persistentCacheKey({
          providerVersion: "unreal-v8",
          bitrate: UNREAL_BITRATE,
          voiceId,
          pitch,
          text,
        });
        const cached = await this.persistentCache.get(key);
        if (cached) return cached;
      } catch {
        // Persistent storage is an optimization. Network narration still works.
        key = null;
      }
    }

    const chunk = await this.fetchChunk(text, voiceId, pitch);
    if (key && this.persistentCache && generation === this.cacheGeneration) {
      void this.persistentCache.set(key, chunk).catch(() => {
        // Do not fail active playback because a local cache write was rejected.
      });
    }
    return chunk;
  }

  private async fetchChunk(
    text: string,
    voiceId: string,
    pitch: number,
  ): Promise<SynthesizedChunk> {
    if (text.length > UNREAL_SPEECH_MAX_CHARS) {
      throw new Error("Unreal Speech: text chunk exceeds the 3,000-character /speech limit");
    }
    const config = this.getConfig();
    const baseUrl = this.requireHttpsBaseUrl(config.baseUrl ?? UNREAL_DEFAULT_BASE_URL);
    const response = (await this.http.postJson(
      `${baseUrl}/speech`,
      {
        Authorization: `Bearer ${config.apiKey.trim()}`,
        "Content-Type": "application/json",
      },
      {
        Text: text,
        VoiceId: voiceId,
        Bitrate: UNREAL_BITRATE,
        OutputFormat: "uri",
        Pitch: pitch,
        Speed: 0,
        TimestampType: "word",
      },
    )) as SpeechResponse;

    if (!response?.OutputUri || !response?.TimestampsUri) {
      throw new Error("Unreal Speech: unexpected /speech response");
    }
    const outputUrl = this.requireHttpsUrl(response.OutputUri);
    const timestampsUrl = this.requireHttpsUrl(response.TimestampsUri);

    const [data, timestamps] = await Promise.all([
      this.http.getBinary(outputUrl),
      this.http.getJson(timestampsUrl),
    ]);

    if (!Array.isArray(timestamps)) {
      throw new Error("Unreal Speech: unexpected word-timestamps response");
    }
    const words: Array<{ text: string; startSec: number; textOffset?: number }> = [];
    let lastStart = -1;
    for (const entry of timestamps as TimestampEntry[]) {
      if (
        typeof entry?.word !== "string" ||
        !entry.word.trim() ||
        typeof entry.start !== "number" ||
        !Number.isFinite(entry.start) ||
        entry.start < 0 ||
        entry.start < lastStart ||
        (entry.text_offset !== undefined &&
          (typeof entry.text_offset !== "number" ||
            !Number.isInteger(entry.text_offset) ||
            entry.text_offset < 0))
      ) {
        throw new Error("Unreal Speech: invalid word timestamp");
      }
      words.push({
        text: entry.word,
        startSec: entry.start,
        ...(entry.text_offset === undefined ? {} : { textOffset: entry.text_offset }),
      });
      lastStart = entry.start;
    }
    if (words.length === 0) {
      throw new Error("Unreal Speech: word timestamps are empty");
    }
    if (data.byteLength === 0) {
      throw new Error("Unreal Speech: audio response is empty");
    }

    return { data, mimeType: "audio/mpeg", words };
  }

  private requireHttpsBaseUrl(value: string): string {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error("Unreal Speech: invalid API base URL");
    }
    if (url.protocol !== "https:") {
      throw new Error("Unreal Speech: API base URL must use HTTPS");
    }
    url.search = "";
    url.hash = "";
    return url.href.replace(/\/+$/, "");
  }

  private requireHttpsUrl(value: string): string {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error("Unreal Speech: invalid download URL");
    }
    if (url.protocol !== "https:") {
      throw new Error("Unreal Speech: refused an insecure download URL");
    }
    return url.href;
  }
}
