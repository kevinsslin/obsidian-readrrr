import type { Token } from "./types";

export interface SourceRange {
  start: number;
  end: number;
}

/** Inclusive token-index span of a sentence. */
export interface TokenSpan {
  start: number;
  end: number;
}

/**
 * For each token, the token-index span of the sentence it belongs to. A
 * sentence ends at (and includes) a token flagged endsSentence or
 * endsParagraph; trailing tokens form a final sentence even without a flag.
 */
export function sentenceTokenSpans(tokens: Token[]): TokenSpan[] {
  const spans: TokenSpan[] = new Array<TokenSpan>(tokens.length);
  let start = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].endsSentence || tokens[i].endsParagraph || i === tokens.length - 1) {
      for (let j = start; j <= i; j++) spans[j] = { start, end: i };
      start = i + 1;
    }
  }
  return spans;
}

function sourceSearchKey(text: string): string {
  return text.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

/**
 * Map display tokens back to their source positions with a forward-only search.
 * Markdown syntax stripped by the tokenizer usually surrounds, rather than
 * rewrites, the displayed token text.
 */
export function alignTokensToSource(source: string, tokens: Token[]): Array<SourceRange | null> {
  const ranges: Array<SourceRange | null> = [];
  let cursor = 0;

  for (const token of tokens) {
    const key = sourceSearchKey(token.text);
    if (!key) {
      ranges.push(null);
      continue;
    }

    const start = source.indexOf(key, cursor);
    if (start === -1) {
      ranges.push(null);
      continue;
    }

    const end = start + key.length;
    ranges.push({ start, end });
    cursor = end;
  }

  return ranges;
}

export function sentenceRangesByToken(
  tokens: Token[],
  ranges: Array<SourceRange | null>,
): Array<SourceRange | null> {
  if (tokens.length === 0) return [];

  const result: Array<SourceRange | null> = new Array<SourceRange | null>(tokens.length).fill(null);
  let sentenceStart = 0;
  let rangeStart: number | null = null;
  let rangeEnd: number | null = null;

  const finishSentence = (sentenceEnd: number): void => {
    const sentenceRange =
      rangeStart === null || rangeEnd === null ? null : { start: rangeStart, end: rangeEnd };
    for (let i = sentenceStart; i <= sentenceEnd; i += 1) {
      result[i] = sentenceRange;
    }
    sentenceStart = sentenceEnd + 1;
    rangeStart = null;
    rangeEnd = null;
  };

  for (let i = 0; i < tokens.length; i += 1) {
    const range = ranges[i];
    if (range) {
      rangeStart = rangeStart === null ? range.start : Math.min(rangeStart, range.start);
      rangeEnd = rangeEnd === null ? range.end : Math.max(rangeEnd, range.end);
    }

    if (tokens[i].endsSentence || tokens[i].endsParagraph) {
      finishSentence(i);
    }
  }

  if (sentenceStart < tokens.length) {
    finishSentence(tokens.length - 1);
  }

  return result;
}
