import { describe, it, expect } from "vitest";
import {
  DEFAULT_TIMING,
  baseWordMs,
  wordDurationMs,
  buildTimeline,
  totalDurationMs,
  indexAtMs,
  type TimingOptions,
} from "./scheduler";
import type { Token } from "./types";

function tok(text: string, flags: Partial<Token> = {}): Token {
  return {
    text,
    endsSentence: false,
    endsClause: false,
    endsParagraph: false,
    ...flags,
  };
}

const T: TimingOptions = { ...DEFAULT_TIMING, wpm: 300 }; // base = 200ms

describe("baseWordMs", () => {
  it("converts WPM to ms per word", () => {
    expect(baseWordMs(300)).toBe(200);
    expect(baseWordMs(600)).toBe(100);
    expect(baseWordMs(60)).toBe(1000);
  });

  it("falls back to the default WPM for non-finite or non-positive input", () => {
    const fallback = 60000 / DEFAULT_TIMING.wpm;
    expect(baseWordMs(0)).toBe(fallback);
    expect(baseWordMs(-5)).toBe(fallback);
    expect(baseWordMs(Number.NaN)).toBe(fallback);
    expect(baseWordMs(Number.POSITIVE_INFINITY)).toBe(fallback);
  });
});

describe("wordDurationMs", () => {
  it("returns the base duration for a short plain word", () => {
    expect(wordDurationMs(tok("cat"), T)).toBe(200);
  });

  it("adds time for long words beyond the threshold", () => {
    // "extraordinary" = 13 word-chars, threshold 8 -> +5 * 22 = 110
    expect(wordDurationMs(tok("extraordinary"), T)).toBe(200 + 110);
  });

  it("counts only word characters toward length, ignoring punctuation", () => {
    // "cat," has 3 word-chars, so no long-word penalty.
    expect(wordDurationMs(tok("cat,", { endsClause: true }), T)).toBe(200 * 1.6);
  });

  it("applies clause, sentence, and paragraph multipliers", () => {
    expect(wordDurationMs(tok("end,", { endsClause: true }), T)).toBe(200 * 1.6);
    expect(wordDurationMs(tok("end.", { endsSentence: true }), T)).toBe(200 * 2.2);
    expect(
      wordDurationMs(tok("end.", { endsSentence: true, endsParagraph: true }), T),
    ).toBe(200 * 2.8);
  });

  it("uses the largest applicable multiplier", () => {
    const both = wordDurationMs(
      tok("x", { endsClause: true, endsSentence: true }),
      T,
    );
    expect(both).toBe(200 * 2.2); // sentence beats clause
  });

  it("never returns less than minWordMs", () => {
    const fast: TimingOptions = { ...T, wpm: 6000, minWordMs: 60 }; // base = 10ms
    expect(wordDurationMs(tok("a"), fast)).toBe(60);
  });
});

describe("buildTimeline", () => {
  it("produces non-decreasing start times beginning at zero", () => {
    const tokens = [tok("one"), tok("two"), tok("three.", { endsSentence: true })];
    const tl = buildTimeline(tokens, T);
    expect(tl).toHaveLength(3);
    expect(tl[0].startMs).toBe(0);
    for (let i = 1; i < tl.length; i++) {
      expect(tl[i].startMs).toBe(tl[i - 1].startMs + tl[i - 1].durationMs);
      expect(tl[i].startMs).toBeGreaterThan(tl[i - 1].startMs);
    }
    expect(tl[2].index).toBe(2);
  });

  it("returns an empty timeline for no tokens", () => {
    expect(buildTimeline([], T)).toEqual([]);
    expect(totalDurationMs([])).toBe(0);
  });

  it("totalDurationMs equals the sum of durations", () => {
    const tokens = [tok("a"), tok("bb"), tok("ccc.", { endsSentence: true })];
    const tl = buildTimeline(tokens, T);
    const sum = tl.reduce((acc, e) => acc + e.durationMs, 0);
    expect(totalDurationMs(tl)).toBe(sum);
  });

  it("stays finite even with a bad WPM", () => {
    const tl = buildTimeline([tok("a"), tok("b.", { endsSentence: true })], {
      ...T,
      wpm: Number.NaN,
    });
    for (const e of tl) {
      expect(Number.isFinite(e.startMs)).toBe(true);
      expect(Number.isFinite(e.durationMs)).toBe(true);
      expect(e.durationMs).toBeGreaterThan(0);
    }
  });
});

describe("indexAtMs", () => {
  // three plain words: starts 0/200/400, each 200ms, end at 600
  const tl = buildTimeline([tok("a"), tok("b"), tok("c")], T);

  it("finds the entry active at a given time", () => {
    expect(indexAtMs(tl, 0)).toBe(0);
    expect(indexAtMs(tl, 199)).toBe(0);
    expect(indexAtMs(tl, 200)).toBe(1);
    expect(indexAtMs(tl, 400)).toBe(2);
    expect(indexAtMs(tl, 599)).toBe(2);
  });

  it("returns length past the end, 0 before start or when empty", () => {
    expect(indexAtMs(tl, 600)).toBe(3);
    expect(indexAtMs(tl, 99999)).toBe(3);
    expect(indexAtMs(tl, -5)).toBe(0);
    expect(indexAtMs([], 123)).toBe(0);
  });
});
