import { describe, expect, it, vi } from "vitest";
import type { Token } from "../core/types";
import type { Clock } from "../reader/clock";
import type { AudioLike, SynthesizedChunk } from "./timed-audio";
import type {
  NarrationCacheStats,
  PersistentNarrationCache,
} from "./persistent-cache";
import {
  UNREAL_DEFAULT_BASE_URL,
  UnrealSpeechProvider,
  type UnrealHttp,
} from "./unreal";

function tok(text: string, flags: Partial<Token> = {}): Token {
  return { text, endsSentence: false, endsClause: false, endsParagraph: false, ...flags };
}

class FakeAudio implements AudioLike {
  src = "";
  currentTime = 0;
  playbackRate = 1;
  volume = 1;
  preservesPitch = false;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  play = vi.fn(() => Promise.resolve());
  pause = vi.fn();
}

class FakePersistentCache implements PersistentNarrationCache {
  readonly entries = new Map<string, SynthesizedChunk>();
  failReads = false;

  async get(key: string): Promise<SynthesizedChunk | null> {
    if (this.failReads) throw new Error("cache unavailable");
    return this.entries.get(key) ?? null;
  }

  async set(key: string, chunk: SynthesizedChunk): Promise<void> {
    this.entries.set(key, chunk);
  }

  async getStats(): Promise<NarrationCacheStats> {
    return { entries: this.entries.size, totalBytes: 0, limitBytes: 1_000 };
  }

  async setLimitBytes(_limitBytes: number): Promise<void> {}

  async clear(): Promise<void> {
    this.entries.clear();
  }

  close(): void {}
}

const OPTS = { voiceId: "Noah", rate: 1.25, pitch: 2, volume: 0.7 };
const INERT_CLOCK: Clock = {
  now: () => 0,
  setTimeout: () => 1,
  clearTimeout: () => {},
};
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

function synthesize(
  provider: UnrealSpeechProvider,
  text: string,
  voiceId = "Noah",
  pitch = 1,
): Promise<SynthesizedChunk> {
  return (
    provider as unknown as {
      synthesize(text: string, voiceId: string, pitch: number): Promise<SynthesizedChunk>;
    }
  ).synthesize(text, voiceId, pitch);
}

function memoryCacheSize(provider: UnrealSpeechProvider): number {
  return (provider as unknown as { cache: Map<string, unknown> }).cache.size;
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function makeHttp(): UnrealHttp & {
  postJson: ReturnType<typeof vi.fn>;
  getJson: ReturnType<typeof vi.fn>;
  getBinary: ReturnType<typeof vi.fn>;
} {
  return {
    postJson: vi.fn(async () => ({
      OutputUri: "https://cdn.example/audio.mp3",
      TimestampsUri: "https://cdn.example/words.json",
    })),
    getJson: vi.fn(async () => [
      { word: "Hello", start: 0, end: 0.3, text_offset: 0 },
      { word: "world.", start: 0.3, end: 0.7, text_offset: 6 },
    ]),
    getBinary: vi.fn(async () => new ArrayBuffer(4)),
  };
}

describe("UnrealSpeechProvider", () => {
  it("exposes the documented multilingual v8 voices", () => {
    const provider = new UnrealSpeechProvider(() => ({ apiKey: "key" }), makeHttp());
    expect(provider.listVoices()).toContainEqual(
      expect.objectContaining({ id: "Sierra", lang: "en-US", isDefault: true }),
    );
    expect(provider.listVoices()).toContainEqual(
      expect.objectContaining({ id: "Mei", lang: "zh-CN" }),
    );
    expect(provider.listVoices()).toContainEqual(
      expect.objectContaining({ id: "Élodie", lang: "fr-FR" }),
    );
  });

  it("requires an API key and reports a useful error without one", () => {
    const provider = new UnrealSpeechProvider(() => ({ apiKey: "  " }), makeHttp());
    const errors: string[] = [];
    expect(provider.isAvailable()).toBe(false);
    provider.speak([tok("Hello")], OPTS, {
      onError: (error) => errors.push(error.message),
    });
    expect(errors).toEqual(["Unreal Speech: no API key configured"]);
  });

  it("posts v8 word-timestamp synthesis and plays the returned audio", async () => {
    const http = makeHttp();
    const audio = new FakeAudio();
    const provider = new UnrealSpeechProvider(
      () => ({ apiKey: " secret " }),
      http,
      { clock: INERT_CLOCK, createAudio: () => audio, toObjectUrl: () => "blob:audio" },
    );
    const spoken: number[] = [];

    provider.speak([tok("Hello"), tok("world.", { endsSentence: true })], OPTS, {
      onWordSpoken: (index) => spoken.push(index),
    });
    await flush();

    expect(http.postJson).toHaveBeenCalledWith(
      `${UNREAL_DEFAULT_BASE_URL}/speech`,
      {
        Authorization: "Bearer secret",
        "Content-Type": "application/json",
      },
      {
        Text: "Hello world.",
        VoiceId: "Noah",
        Bitrate: "128k",
        OutputFormat: "uri",
        Pitch: 1.5,
        Speed: 0,
        TimestampType: "word",
      },
    );
    expect(http.getBinary).toHaveBeenCalledWith("https://cdn.example/audio.mp3");
    expect(http.getJson).toHaveBeenCalledWith("https://cdn.example/words.json");
    expect(audio.src).toBe("blob:audio");
    expect(audio.playbackRate).toBe(1.25);
    expect(audio.volume).toBe(0.7);
    expect(spoken).toEqual([0]);

    audio.currentTime = 0.3;
    // End the chunk to verify cleanup does not retain the completed session.
    audio.onended?.();
    expect((provider as unknown as { activeSession: unknown }).activeSession).toBeNull();
    expect(audio.src).toBe("");
  });

  it("reuses persistent audio across provider instances and WPM changes", async () => {
    const http = makeHttp();
    const cache = new FakePersistentCache();
    const firstAudio = new FakeAudio();
    const first = new UnrealSpeechProvider(
      () => ({ apiKey: "key" }),
      http,
      { clock: INERT_CLOCK, createAudio: () => firstAudio, toObjectUrl: () => "blob:first" },
      cache,
    );
    const tokens = [tok("Hello"), tok("world.", { endsSentence: true })];

    first.speak(tokens, OPTS, {});
    await vi.waitFor(() => expect(http.postJson).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(cache.entries.size).toBe(1));

    http.postJson.mockClear();
    http.getJson.mockClear();
    http.getBinary.mockClear();
    const secondAudio = new FakeAudio();
    const second = new UnrealSpeechProvider(
      () => ({ apiKey: "different-key" }),
      http,
      { clock: INERT_CLOCK, createAudio: () => secondAudio, toObjectUrl: () => "blob:cached" },
      cache,
    );
    second.speak(tokens, { ...OPTS, rate: 4, volume: 0.1, startTokenIndex: 1 }, {});
    await vi.waitFor(() => expect(secondAudio.src).toBe("blob:cached"));
    expect(secondAudio.currentTime).toBe(0.3);
    expect(http.postJson).not.toHaveBeenCalled();

    const changedVoice = new UnrealSpeechProvider(
      () => ({ apiKey: "key" }),
      http,
      { clock: INERT_CLOCK, createAudio: () => new FakeAudio(), toObjectUrl: () => "blob:new" },
      cache,
    );
    changedVoice.speak(tokens, { ...OPTS, voiceId: "Sierra" }, {});
    await vi.waitFor(() => expect(http.postJson).toHaveBeenCalledTimes(1));
  });

  it("evicts least-recently-used fulfilled chunks by byte budget", async () => {
    const http = makeHttp();
    const sample = {
      data: new ArrayBuffer(4),
      mimeType: "audio/mpeg",
      words: [
        { text: "Hello", startSec: 0, textOffset: 0 },
        { text: "world.", startSec: 0.3, textOffset: 6 },
      ],
    } satisfies SynthesizedChunk;
    const chunkBytes =
      sample.data.byteLength + new TextEncoder().encode(JSON.stringify(sample.words)).byteLength;
    const provider = new UnrealSpeechProvider(
      () => ({ apiKey: "key" }),
      http,
      {},
      null,
      chunkBytes * 2,
    );

    await synthesize(provider, "first");
    await synthesize(provider, "second");
    await synthesize(provider, "first"); // refresh first as most recently used
    await synthesize(provider, "third");
    expect(memoryCacheSize(provider)).toBe(2);
    expect(http.postJson).toHaveBeenCalledTimes(3);

    await synthesize(provider, "second");
    expect(http.postJson).toHaveBeenCalledTimes(4);
  });

  it("does not retain a fulfilled chunk larger than the memory budget", async () => {
    const http = makeHttp();
    const provider = new UnrealSpeechProvider(
      () => ({ apiKey: "key" }),
      http,
      {},
      null,
      1,
    );

    await synthesize(provider, "oversized");
    expect(memoryCacheSize(provider)).toBe(0);
    await synthesize(provider, "oversized");
    expect(http.postJson).toHaveBeenCalledTimes(2);
  });

  it("clears memory hits and suppresses stale persistent writes", async () => {
    const http = makeHttp();
    const binary = deferred<ArrayBuffer>();
    http.getBinary.mockImplementation(() => binary.promise);
    const cache = new FakePersistentCache();
    const provider = new UnrealSpeechProvider(
      () => ({ apiKey: "key" }),
      http,
      {},
      cache,
    );

    const pending = synthesize(provider, "clear me");
    await vi.waitFor(() => expect(http.postJson).toHaveBeenCalledTimes(1));
    provider.clearCache();
    expect(memoryCacheSize(provider)).toBe(0);
    binary.resolve(new ArrayBuffer(4));
    await pending;
    await flush();
    expect(cache.entries.size).toBe(0);
    expect(memoryCacheSize(provider)).toBe(0);

    await synthesize(provider, "clear me");
    expect(http.postJson).toHaveBeenCalledTimes(2);
  });

  it("bounds unresolved synthesis entries", async () => {
    const http = makeHttp();
    const response = deferred<unknown>();
    http.postJson.mockImplementation(() => response.promise);
    const provider = new UnrealSpeechProvider(() => ({ apiKey: "key" }), http);

    const pending = Array.from({ length: 40 }, (_, index) =>
      synthesize(provider, `pending ${index}`),
    );
    expect(memoryCacheSize(provider)).toBe(32);
    response.resolve({
      OutputUri: "https://cdn.example/audio.mp3",
      TimestampsUri: "https://cdn.example/words.json",
    });
    await Promise.all(pending);
  });

  it("falls back to the network when persistent storage is unavailable", async () => {
    const http = makeHttp();
    const cache = new FakePersistentCache();
    cache.failReads = true;
    const provider = new UnrealSpeechProvider(
      () => ({ apiKey: "key" }),
      http,
      { clock: INERT_CLOCK, createAudio: () => new FakeAudio(), toObjectUrl: () => "blob:1" },
      cache,
    );

    provider.speak([tok("Hello")], OPTS, {});
    await vi.waitFor(() => expect(http.postJson).toHaveBeenCalledTimes(1));
  });

  it("groups short sentences into one long-form synthesis request", async () => {
    const http = makeHttp();
    const provider = new UnrealSpeechProvider(
      () => ({ apiKey: "key" }),
      http,
      { clock: INERT_CLOCK, createAudio: () => new FakeAudio(), toObjectUrl: () => "blob:1" },
    );

    provider.speak(
      [
        tok("One.", { endsSentence: true }),
        tok("Two.", { endsSentence: true }),
        tok("Three.", { endsSentence: true }),
      ],
      OPTS,
      {},
    );
    await flush();

    expect(http.postJson).toHaveBeenCalledTimes(1);
    expect(http.postJson).toHaveBeenCalledWith(
      `${UNREAL_DEFAULT_BASE_URL}/speech`,
      expect.any(Object),
      expect.objectContaining({ Text: "One. Two. Three." }),
    );
  });

  it("falls back to Sierra for an unknown voice and caches identical chunks", async () => {
    const http = makeHttp();
    const audios = [new FakeAudio(), new FakeAudio()];
    let audioIndex = 0;
    const provider = new UnrealSpeechProvider(
      () => ({ apiKey: "key", baseUrl: "https://custom.example/" }),
      http,
      {
        clock: INERT_CLOCK,
        createAudio: () => audios[audioIndex++],
        toObjectUrl: () => `blob:${audioIndex}`,
      },
    );
    const options = { ...OPTS, voiceId: "missing", pitch: 1 };
    const tokens = [tok("Hello")];

    provider.speak(tokens, options, {});
    await flush();
    provider.speak(tokens, options, {});
    await flush();

    expect(http.postJson).toHaveBeenCalledTimes(1);
    expect(http.postJson).toHaveBeenCalledWith(
      "https://custom.example/speech",
      expect.any(Object),
      expect.objectContaining({ VoiceId: "Sierra" }),
    );
  });

  it("rejects a single token that exceeds the /speech character limit", async () => {
    const http = makeHttp();
    const provider = new UnrealSpeechProvider(
      () => ({ apiKey: "key" }),
      http,
      { clock: INERT_CLOCK, createAudio: () => new FakeAudio(), toObjectUrl: () => "blob:1" },
    );
    const errors: string[] = [];

    provider.speak([tok("x".repeat(3_001))], OPTS, {
      onError: (error) => errors.push(error.message),
    });
    await flush();

    expect(errors).toEqual([
      "Unreal Speech: text chunk exceeds the 3,000-character /speech limit",
    ]);
    expect(http.postJson).not.toHaveBeenCalled();
  });

  it("rejects invalid word timing data before playback", async () => {
    const http = makeHttp();
    http.getJson.mockResolvedValue([
      { word: "Hello", start: 0 },
      { word: "world", start: Number.NaN },
    ]);
    const audio = new FakeAudio();
    const provider = new UnrealSpeechProvider(
      () => ({ apiKey: "key" }),
      http,
      { clock: INERT_CLOCK, createAudio: () => audio, toObjectUrl: () => "blob:1" },
    );
    const errors: string[] = [];

    provider.speak([tok("Hello"), tok("world")], OPTS, {
      onError: (error) => errors.push(error.message),
    });
    await flush();

    expect(errors).toEqual(["Unreal Speech: invalid word timestamp"]);
    expect(audio.src).toBe("");
  });

  it("refuses an insecure API base URL before sending the key", async () => {
    const http = makeHttp();
    const provider = new UnrealSpeechProvider(
      () => ({ apiKey: "key", baseUrl: "http://custom.example" }),
      http,
      { clock: INERT_CLOCK, createAudio: () => new FakeAudio(), toObjectUrl: () => "blob:1" },
    );
    const errors: string[] = [];

    provider.speak([tok("Hello")], OPTS, {
      onError: (error) => errors.push(error.message),
    });
    await flush();

    expect(errors).toEqual(["Unreal Speech: API base URL must use HTTPS"]);
    expect(http.postJson).not.toHaveBeenCalled();
  });

  it("refuses non-HTTPS download URLs returned by the API", async () => {
    const http = makeHttp();
    http.postJson.mockResolvedValue({
      OutputUri: "http://cdn.example/audio.mp3",
      TimestampsUri: "https://cdn.example/words.json",
    });
    const provider = new UnrealSpeechProvider(
      () => ({ apiKey: "key" }),
      http,
      { clock: INERT_CLOCK, createAudio: () => new FakeAudio(), toObjectUrl: () => "blob:1" },
    );
    const errors: string[] = [];

    provider.speak([tok("Hello")], OPTS, {
      onError: (error) => errors.push(error.message),
    });
    await flush();

    expect(errors).toEqual(["Unreal Speech: refused an insecure download URL"]);
    expect(http.getBinary).not.toHaveBeenCalled();
  });

  it("surfaces malformed API responses", async () => {
    const http = makeHttp();
    http.postJson.mockResolvedValue({ OutputUri: "only-one-url" });
    const provider = new UnrealSpeechProvider(
      () => ({ apiKey: "key" }),
      http,
      { clock: INERT_CLOCK, createAudio: () => new FakeAudio(), toObjectUrl: () => "blob:1" },
    );
    const errors: string[] = [];

    provider.speak([tok("Hello")], OPTS, {
      onError: (error) => errors.push(error.message),
    });
    await flush();

    expect(errors).toEqual(["Unreal Speech: unexpected /speech response"]);
  });
});
