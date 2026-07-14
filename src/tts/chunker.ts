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
 * Group tokens into utterances without exceeding token or character caps.
 * `minCharsPerChunk` lets cloud providers combine short sentences, then prefer
 * the next sentence/paragraph boundary once enough text has accumulated.
 */
export function buildUtterances(
  tokens: Token[],
  opts: {
    maxTokensPerChunk?: number;
    maxCharsPerChunk?: number;
    minCharsPerChunk?: number;
  } = {},
): Utterance[] {
  const maxTokens = Math.max(1, opts.maxTokensPerChunk ?? 40);
  const maxChars = Math.max(1, opts.maxCharsPerChunk ?? Number.POSITIVE_INFINITY);
  const minChars = Math.min(maxChars, Math.max(0, opts.minCharsPerChunk ?? 0));
  const utterances: Utterance[] = [];
  let start = 0;

  while (start < tokens.length) {
    let end = start;
    let charCount = 0;
    while (end < tokens.length) {
      const token = tokens[end];
      const nextCharCount = charCount + (end > start ? 1 : 0) + token.text.length;
      // Keep provider requests under their character limit. A single oversized
      // token is left intact so token indices remain meaningful; the provider
      // can reject it with a useful limit error instead of splitting one word.
      if (end > start && nextCharCount > maxChars) break;
      charCount = nextCharCount;
      end++;
      if (end - start >= maxTokens) break;
      if ((token.endsSentence || token.endsParagraph) && charCount >= minChars) break;
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
