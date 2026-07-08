import type { Token } from "../core/types";

/**
 * A single spoken unit (roughly one sentence). Speaking sentence-by-sentence
 * means the display can resync at every chunk end, which is what keeps audio
 * and words aligned even when fine-grained boundary events are unavailable.
 */
export interface Utterance {
  /** The text handed to the speech engine. */
  text: string;
  /** Absolute index of this chunk's first token. */
  tokenStart: number;
  /** Number of tokens in this chunk. */
  tokenCount: number;
  /** `charStarts[i]` is where relative token i begins within `text`. */
  charStarts: number[];
}

/**
 * Group tokens into utterances, breaking at sentence/paragraph ends and never
 * exceeding `maxTokensPerChunk` (so a run-on paragraph still resyncs often).
 */
export function buildUtterances(
  tokens: Token[],
  opts: { maxTokensPerChunk?: number } = {},
): Utterance[] {
  const max = Math.max(1, opts.maxTokensPerChunk ?? 40);
  const utterances: Utterance[] = [];
  let start = 0;

  while (start < tokens.length) {
    let end = start;
    while (end < tokens.length) {
      const token = tokens[end];
      end++;
      if (token.endsSentence || token.endsParagraph) break;
      if (end - start >= max) break;
    }

    const chunk = tokens.slice(start, end);
    let text = "";
    const charStarts: number[] = [];
    for (let i = 0; i < chunk.length; i++) {
      if (i > 0) text += " ";
      charStarts.push(text.length);
      text += chunk[i].text;
    }

    utterances.push({ text, tokenStart: start, tokenCount: chunk.length, charStarts });
    start = end;
  }

  return utterances;
}

/**
 * Map a boundary event's character index (within an utterance's text) to the
 * relative token index it falls in: the last token whose start is <= charIndex.
 */
export function charIndexToRelToken(charStarts: number[], charIndex: number): number {
  if (charStarts.length === 0) return 0;
  let lo = 0;
  let hi = charStarts.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (charStarts[mid] <= charIndex) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}
