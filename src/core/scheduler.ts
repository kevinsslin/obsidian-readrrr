import type { Token, TimelineEntry } from "./types";

export interface TimingOptions {
  /** Base reading speed in words per minute. */
  wpm: number;
  /** Words with more word-characters than this get extra display time. */
  longWordThreshold: number;
  /** Extra milliseconds per word-character beyond the threshold. */
  extraMsPerChar: number;
  /** Dwell multiplier for words that end a clause. */
  clauseMultiplier: number;
  /** Dwell multiplier for words that end a sentence. */
  sentenceMultiplier: number;
  /** Dwell multiplier for words that end a paragraph. */
  paragraphMultiplier: number;
  /** Never show a word for less than this many milliseconds. */
  minWordMs: number;
}

export const DEFAULT_TIMING: TimingOptions = {
  wpm: 300,
  longWordThreshold: 8,
  extraMsPerChar: 22,
  clauseMultiplier: 1.6,
  sentenceMultiplier: 2.2,
  paragraphMultiplier: 2.8,
  minWordMs: 60,
};

/**
 * Milliseconds per word at a given WPM, before any modifiers. A non-finite or
 * non-positive WPM falls back to the default so a bad value can never poison
 * the timeline with `NaN`/`Infinity`.
 */
export function baseWordMs(wpm: number): number {
  if (!Number.isFinite(wpm) || wpm <= 0) return 60000 / DEFAULT_TIMING.wpm;
  return 60000 / wpm;
}

function wordCharCount(s: string): number {
  const m = s.match(/[\p{L}\p{N}]/gu);
  return m ? m.length : s.length;
}

/**
 * How long a single word should stay on screen. Long words get more time, and
 * clause/sentence/paragraph endings dwell longer (the largest applicable
 * multiplier wins). Never returns less than `minWordMs`.
 */
export function wordDurationMs(token: Token, opts: TimingOptions): number {
  let ms = baseWordMs(opts.wpm);

  const len = wordCharCount(token.text);
  if (len > opts.longWordThreshold) {
    ms += (len - opts.longWordThreshold) * opts.extraMsPerChar;
  }

  let multiplier = 1;
  if (token.endsParagraph) multiplier = Math.max(multiplier, opts.paragraphMultiplier);
  if (token.endsSentence) multiplier = Math.max(multiplier, opts.sentenceMultiplier);
  if (token.endsClause) multiplier = Math.max(multiplier, opts.clauseMultiplier);
  ms *= multiplier;

  return Math.max(opts.minWordMs, ms);
}

/**
 * Build the full playback timeline: each token with its absolute start time
 * and duration. `startMs` is strictly non-decreasing and begins at 0.
 */
export function buildTimeline(tokens: Token[], opts: TimingOptions): TimelineEntry[] {
  const timeline: TimelineEntry[] = [];
  let cursor = 0;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    const durationMs = wordDurationMs(token, opts);
    timeline.push({ index, token, startMs: cursor, durationMs });
    cursor += durationMs;
  }
  return timeline;
}

/** Total run length in milliseconds. */
export function totalDurationMs(timeline: TimelineEntry[]): number {
  if (timeline.length === 0) return 0;
  const last = timeline[timeline.length - 1];
  return last.startMs + last.durationMs;
}

/**
 * Index of the timeline entry active at time `ms`: the last entry whose start
 * is <= ms. Returns 0 before the start (or for an empty timeline), and
 * `timeline.length` once `ms` is at or past the end (a "finished" sentinel).
 */
export function indexAtMs(timeline: TimelineEntry[], ms: number): number {
  if (timeline.length === 0) return 0;
  if (ms < 0) return 0;
  const last = timeline[timeline.length - 1];
  if (ms >= last.startMs + last.durationMs) return timeline.length;

  let lo = 0;
  let hi = timeline.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (timeline[mid].startMs <= ms) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}
