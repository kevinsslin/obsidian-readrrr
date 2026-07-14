import { describe, expect, it, vi } from "vitest";
import type { Token } from "../core/types";
import type { Clock } from "../reader/clock";
import { buildUtterances } from "./chunker";
import {
  TimedAudioSession,
  mapWordsToTokens,
  type AudioLike,
  type SynthesizedChunk,
} from "./timed-audio";

function tok(text: string, flags: Partial<Token> = {}): Token {
  return { text, endsSentence: false, endsClause: false, endsParagraph: false, ...flags };
}

class FakeClock implements Clock {
  private nowMs = 0;
  private nextId = 1;
  private timers = new Map<number, { due: number; fn: () => void }>();

  now(): number {
    return this.nowMs;
  }

  setTimeout(fn: () => void, ms: number): number {
    const id = this.nextId++;
    this.timers.set(id, { due: this.nowMs + ms, fn });
    return id;
  }

  clearTimeout(handle: number): void {
    this.timers.delete(handle);
  }

  advance(ms: number): void {
    const target = this.nowMs + ms;
    for (;;) {
      let selected: [number, { due: number; fn: () => void }] | null = null;
      for (const entry of this.timers) {
        if (entry[1].due > target) continue;
        if (!selected || entry[1].due < selected[1].due) selected = entry;
      }
      if (!selected) break;
      this.timers.delete(selected[0]);
      this.nowMs = selected[1].due;
      selected[1].fn();
    }
    this.nowMs = target;
  }
}

class FakeAudio implements AudioLike {
  src = "";
  currentTime = 0;
  playbackRate = 1;
  volume = 1;
  preservesPitch = false;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  playCount = 0;
  pauseCount = 0;
  rejectPlay = false;

  play(): Promise<void> {
    this.playCount++;
    return this.rejectPlay ? Promise.reject(new Error("blocked")) : Promise.resolve();
  }

  pause(): void {
    this.pauseCount++;
  }
}

const OPTS = { voiceId: null, rate: 1.5, pitch: 1, volume: 0.8, maxTokensPerChunk: 40 };
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

function synthesized(words: Array<{ text: string; startSec: number }>): SynthesizedChunk {
  return { data: new ArrayBuffer(2), mimeType: "audio/mpeg", words };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(err: Error): void } {
  let resolve!: (value: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("mapWordsToTokens", () => {
  it("maps repeated provider words to their matching token occurrences", () => {
    const utterance = buildUtterances([tok("go"), tok("go"), tok("now.")])[0];
    expect(
      mapWordsToTokens(utterance, [
        { text: "go", startSec: 0 },
        { text: "go", startSec: 0.2 },
        { text: "now.", startSec: 0.4 },
      ]),
    ).toEqual([
      { relToken: 0, startSec: 0 },
      { relToken: 1, startSec: 0.2 },
      { relToken: 2, startSec: 0.4 },
    ]);
  });

  it("tolerates provider punctuation and Unicode normalization", () => {
    const utterance = buildUtterances([tok("Hello,"), tok("CAFÉ!")])[0];
    expect(
      mapWordsToTokens(utterance, [
        { text: "Hello", startSec: 0 },
        { text: "café", startSec: 0.25 },
      ]),
    ).toEqual([
      { relToken: 0, startSec: 0 },
      { relToken: 1, startSec: 0.25 },
    ]);
  });

  it("uses provider text offsets when the spoken form expands a token", () => {
    const utterance = buildUtterances([tok("In"), tok("2026,"), tok("we")])[0];
    expect(
      mapWordsToTokens(utterance, [
        { text: "In", startSec: 0, textOffset: 0 },
        { text: "two", startSec: 0.2, textOffset: 3 },
        { text: "thousand", startSec: 0.35, textOffset: 3 },
        { text: "we", startSec: 0.7, textOffset: 9 },
      ]),
    ).toEqual([
      { relToken: 0, startSec: 0 },
      { relToken: 1, startSec: 0.2 },
      { relToken: 1, startSec: 0.35 },
      { relToken: 2, startSec: 0.7 },
    ]);
  });

  it("prefers text offsets over a matching later token", () => {
    const utterance = buildUtterances([tok("1"), tok("one")])[0];
    expect(
      mapWordsToTokens(utterance, [
        { text: "one", startSec: 0, textOffset: 0 },
        { text: "one", startSec: 0.2, textOffset: 2 },
      ]),
    ).toEqual([
      { relToken: 0, startSec: 0 },
      { relToken: 1, startSec: 0.2 },
    ]);
  });
});

describe("TimedAudioSession", () => {
  it("plays chunks, emits timed words, prefetches, and advances at chunk end", async () => {
    const clock = new FakeClock();
    const audio = new FakeAudio();
    const synthesize = vi.fn(async (text: string) =>
      text.startsWith("One")
        ? synthesized([
            { text: "One", startSec: 0 },
            { text: "two.", startSec: 0.5 },
          ])
        : synthesized([
            { text: "Three", startSec: 0 },
            { text: "four.", startSec: 0.4 },
          ]),
    );
    const words: number[] = [];
    const sentenceEnds: number[] = [];
    let ended = false;
    const revoked: string[] = [];
    let urlId = 0;

    const session = new TimedAudioSession(
      {
        tokens: [
          tok("One"),
          tok("two.", { endsSentence: true }),
          tok("Three"),
          tok("four.", { endsSentence: true }),
        ],
        opts: OPTS,
        events: {
          onWordSpoken: (index) => words.push(index),
          onSentenceEnd: (index) => sentenceEnds.push(index),
          onEnd: () => {
            ended = true;
          },
        },
        synthesize,
      },
      {
        clock,
        createAudio: () => audio,
        toObjectUrl: () => `blob:${++urlId}`,
        revokeObjectUrl: (url) => revoked.push(url),
      },
    );

    session.start();
    await flush();
    expect(synthesize).toHaveBeenCalledWith("One two.");
    expect(synthesize).toHaveBeenCalledWith("Three four."); // prefetched
    expect(audio.src).toBe("blob:1");
    expect(audio.playbackRate).toBe(1.5);
    expect(audio.volume).toBe(0.8);
    expect(audio.preservesPitch).toBe(true);
    expect(words).toEqual([0]);
    expect(
      (session as unknown as { prefetched: Map<number, Promise<SynthesizedChunk>> }).prefetched
        .size,
    ).toBe(1); // only the next chunk, not the current audio bytes

    audio.currentTime = 0.5;
    clock.advance(500);
    expect(words).toEqual([0, 1]);

    audio.onended?.();
    await flush();
    expect(sentenceEnds).toEqual([2]);
    expect(audio.src).toBe("blob:2");
    expect(revoked).toEqual(["blob:1"]);
    expect(words).toEqual([0, 1, 2]);
    expect(
      (session as unknown as { prefetched: Map<number, Promise<SynthesizedChunk>> }).prefetched
        .size,
    ).toBe(0);

    audio.currentTime = 0.4;
    clock.advance(400);
    expect(words).toEqual([0, 1, 2, 3]);
    audio.onended?.();
    expect(ended).toBe(true);

    session.stop();
    expect(revoked).toEqual(["blob:1", "blob:2"]);
    expect(audio.src).toBe("");
  });

  it("resumes inside a stable full-document chunk", async () => {
    const clock = new FakeClock();
    const audio = new FakeAudio();
    const synthesize = vi.fn(() =>
      Promise.resolve(
        synthesized([
          { text: "One", startSec: 0 },
          { text: "two.", startSec: 0.5 },
        ]),
      ),
    );
    const words: number[] = [];
    const session = new TimedAudioSession(
      {
        tokens: [tok("One"), tok("two.", { endsSentence: true })],
        opts: { ...OPTS, startTokenIndex: 1 },
        events: { onWordSpoken: (index) => words.push(index) },
        synthesize,
      },
      { clock, createAudio: () => audio, toObjectUrl: () => "blob:stable" },
    );

    session.start();
    await flush();
    expect(synthesize).toHaveBeenCalledWith("One two.");
    expect(audio.currentTime).toBe(0.5);
    expect(words).toEqual([1]);
    session.stop();
  });

  it("waits for the configured startup buffer before playing", async () => {
    const clock = new FakeClock();
    const audio = new FakeAudio();
    const first = deferred<SynthesizedChunk>();
    const second = deferred<SynthesizedChunk>();
    const third = deferred<SynthesizedChunk>();
    const pending = new Map([
      ["One.", first],
      ["Two.", second],
      ["Three.", third],
    ]);
    const synthesize = vi.fn((text: string) => pending.get(text)!.promise);
    let urlId = 0;
    const session = new TimedAudioSession(
      {
        tokens: [
          tok("One.", { endsSentence: true }),
          tok("Two.", { endsSentence: true }),
          tok("Three.", { endsSentence: true }),
        ],
        opts: { ...OPTS, maxTokensPerChunk: 1 },
        events: {},
        initialBufferChunks: 2,
        prefetchChunks: 2,
        synthesize,
      },
      {
        clock,
        createAudio: () => audio,
        toObjectUrl: () => `blob:${++urlId}`,
        revokeObjectUrl: () => {},
      },
    );

    session.start();
    await flush();
    expect(synthesize.mock.calls.map(([text]) => text)).toEqual(["One.", "Two."]);
    expect(audio.playCount).toBe(1); // user-gesture priming only

    first.resolve(synthesized([{ text: "One.", startSec: 0 }]));
    await flush();
    expect(audio.playCount).toBe(1); // still waiting for the second buffered chunk

    second.resolve(synthesized([{ text: "Two.", startSec: 0 }]));
    await flush();
    expect(audio.playCount).toBe(2);
    expect(audio.src).toBe("blob:1");
    expect(synthesize.mock.calls.map(([text]) => text)).toEqual(["One.", "Two.", "Three."]);

    third.resolve(synthesized([{ text: "Three.", startSec: 0 }]));
    await flush();
    session.stop();
  });

  it("keeps a bounded rolling lookahead instead of fetching the whole note", async () => {
    const clock = new FakeClock();
    const audio = new FakeAudio();
    const synthesize = vi.fn((text: string) =>
      Promise.resolve(synthesized([{ text, startSec: 0 }])),
    );
    let urlId = 0;
    const session = new TimedAudioSession(
      {
        tokens: ["One.", "Two.", "Three.", "Four.", "Five."].map((text) =>
          tok(text, { endsSentence: true }),
        ),
        opts: { ...OPTS, rate: 4, maxTokensPerChunk: 1 },
        events: {},
        initialBufferChunks: 2,
        prefetchChunks: 2,
        synthesize,
      },
      {
        clock,
        createAudio: () => audio,
        toObjectUrl: () => `blob:${++urlId}`,
        revokeObjectUrl: () => {},
      },
    );

    session.start();
    await flush();
    expect(synthesize.mock.calls.map(([text]) => text)).toEqual(["One.", "Two.", "Three."]);
    expect(
      (session as unknown as { prefetched: Map<number, Promise<SynthesizedChunk>> }).prefetched
        .size,
    ).toBe(2);

    audio.onended?.();
    await flush();
    expect(synthesize.mock.calls.map(([text]) => text)).toEqual([
      "One.",
      "Two.",
      "Three.",
      "Four.",
    ]);
    expect(
      (session as unknown as { prefetched: Map<number, Promise<SynthesizedChunk>> }).prefetched
        .size,
    ).toBe(2);
    session.stop();
  });

  it("retries a failed speculative prefetch only when that chunk is needed", async () => {
    const clock = new FakeClock();
    const audio = new FakeAudio();
    const attempts = new Map<string, number>();
    const errors: string[] = [];
    const synthesize = vi.fn((text: string) => {
      const attempt = (attempts.get(text) ?? 0) + 1;
      attempts.set(text, attempt);
      if (text === "Two." && attempt === 1) return Promise.reject(new Error("temporary"));
      return Promise.resolve(synthesized([{ text, startSec: 0 }]));
    });
    let urlId = 0;
    const session = new TimedAudioSession(
      {
        tokens: ["One.", "Two.", "Three."].map((text) =>
          tok(text, { endsSentence: true }),
        ),
        opts: { ...OPTS, maxTokensPerChunk: 1 },
        events: { onError: (error) => errors.push(error.message) },
        prefetchChunks: 2,
        synthesize,
      },
      {
        clock,
        createAudio: () => audio,
        toObjectUrl: () => `blob:${++urlId}`,
        revokeObjectUrl: () => {},
      },
    );

    session.start();
    await flush();
    expect(attempts.get("Two.")).toBe(1);
    expect(errors).toEqual([]);

    audio.onended?.();
    await flush();
    expect(attempts.get("Two.")).toBe(2);
    expect(audio.playCount).toBe(3); // priming, first chunk, retried second chunk
    expect(errors).toEqual([]);
    session.stop();
  });

  it("waits for synthesis when paused and resumed before audio is ready", async () => {
    const clock = new FakeClock();
    const audio = new FakeAudio();
    let resolve!: (chunk: SynthesizedChunk) => void;
    const pending = new Promise<SynthesizedChunk>((done) => {
      resolve = done;
    });
    const words: number[] = [];
    const errors: string[] = [];
    const session = new TimedAudioSession(
      {
        tokens: [tok("One")],
        opts: OPTS,
        events: {
          onWordSpoken: (index) => words.push(index),
          onError: (error) => errors.push(error.message),
        },
        synthesize: () => pending,
      },
      { clock, createAudio: () => audio, toObjectUrl: () => "blob:1" },
    );

    session.start();
    await flush(); // let the priming source clear before the network finishes
    session.pause();
    session.resume();
    expect(audio.playCount).toBe(1); // no play() call against an empty source
    expect(errors).toEqual([]);

    resolve(synthesized([{ text: "One", startSec: 0 }]));
    await flush();
    expect(audio.playCount).toBe(2);
    expect(words).toEqual([0]);

    session.stop();
    expect(audio.pauseCount).toBeGreaterThan(0);
  });

  it("suppresses synthesis that resolves after stop", async () => {
    const clock = new FakeClock();
    const audio = new FakeAudio();
    let resolve!: (chunk: SynthesizedChunk) => void;
    const pending = new Promise<SynthesizedChunk>((done) => {
      resolve = done;
    });
    const words: number[] = [];
    const session = new TimedAudioSession(
      {
        tokens: [
          tok("One.", { endsSentence: true }),
          tok("Two.", { endsSentence: true }),
        ],
        opts: { ...OPTS, maxTokensPerChunk: 1 },
        events: { onWordSpoken: (index) => words.push(index) },
        initialBufferChunks: 2,
        synthesize: () => pending,
      },
      { clock, createAudio: () => audio, toObjectUrl: () => "blob:1" },
    );

    session.start();
    session.stop();
    resolve(synthesized([{ text: "One", startSec: 0 }]));
    await flush();

    expect(audio.playCount).toBe(1); // muted priming only
    expect(audio.src).toBe("");
    expect(words).toEqual([]);
  });

  it("does not replay an ended chunk while the next prefetch is pending", async () => {
    const clock = new FakeClock();
    const audio = new FakeAudio();
    let resolveNext!: (chunk: SynthesizedChunk) => void;
    const nextPending = new Promise<SynthesizedChunk>((done) => {
      resolveNext = done;
    });
    const sentenceEnds: number[] = [];
    const session = new TimedAudioSession(
      {
        tokens: [tok("One.", { endsSentence: true }), tok("Two.", { endsSentence: true })],
        opts: OPTS,
        events: { onSentenceEnd: (index) => sentenceEnds.push(index) },
        synthesize: (text) =>
          text === "One."
            ? Promise.resolve(synthesized([{ text: "One.", startSec: 0 }]))
            : nextPending,
      },
      { clock, createAudio: () => audio, toObjectUrl: () => `blob:${audio.playCount}` },
    );

    session.start();
    await flush();
    expect(audio.playCount).toBe(2); // priming plus the first chunk

    audio.onended?.();
    session.pause();
    session.resume();
    await flush();
    expect(audio.playCount).toBe(2); // the ended first chunk was not replayed
    expect(sentenceEnds).toEqual([]);

    resolveNext(synthesized([{ text: "Two.", startSec: 0 }]));
    await flush();
    expect(audio.playCount).toBe(3);
    expect(sentenceEnds).toEqual([1]);
    session.stop();
  });

  it("times out stalled synthesis instead of waiting forever", async () => {
    const clock = new FakeClock();
    const audio = new FakeAudio();
    const errors: string[] = [];
    const invalidateSynthesis = vi.fn();
    const session = new TimedAudioSession(
      {
        tokens: [tok("One")],
        opts: OPTS,
        events: { onError: (error) => errors.push(error.message) },
        synthesisTimeoutMs: 1_000,
        synthesize: () => new Promise<SynthesizedChunk>(() => undefined),
        invalidateSynthesis,
      },
      { clock, createAudio: () => audio, toObjectUrl: () => "blob:1" },
    );

    session.start();
    clock.advance(999);
    await flush();
    expect(errors).toEqual([]);
    clock.advance(1);
    await flush();
    expect(errors).toEqual(["Speech synthesis timed out"]);
    expect(invalidateSynthesis).toHaveBeenCalledWith("One", expect.any(Promise));
    expect(audio.src).toBe("");
  });

  it("reports synthesis and playback failures once", async () => {
    const synthesisErrors: string[] = [];
    const failedSynthesis = new TimedAudioSession(
      {
        tokens: [tok("One")],
        opts: OPTS,
        events: { onError: (error) => synthesisErrors.push(error.message) },
        synthesize: () => Promise.reject(new Error("bad key")),
      },
      {
        clock: new FakeClock(),
        createAudio: () => new FakeAudio(),
        toObjectUrl: () => "blob:prime",
      },
    );
    failedSynthesis.start();
    await flush();
    expect(synthesisErrors).toEqual(["bad key"]);

    const audio = new FakeAudio();
    audio.rejectPlay = true;
    const playbackErrors: string[] = [];
    const failedPlayback = new TimedAudioSession(
      {
        tokens: [tok("One")],
        opts: OPTS,
        events: { onError: (error) => playbackErrors.push(error.message) },
        synthesize: () => Promise.resolve(synthesized([{ text: "One", startSec: 0 }])),
      },
      { clock: new FakeClock(), createAudio: () => audio, toObjectUrl: () => "blob:1" },
    );
    failedPlayback.start();
    await flush();
    expect(playbackErrors).toEqual(["Audio playback failed"]);
  });
});
