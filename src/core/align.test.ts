import { describe, it, expect } from "vitest";
import {
  alignTokensToSource,
  sentenceRangesByToken,
  sentenceTokenSpans,
  type SourceRange,
} from "./align";
import { tokenize } from "./tokenizer";
import type { Token } from "./types";

function searchKey(text: string): string {
  return text.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

function token(
  text: string,
  flags: Partial<Pick<Token, "endsSentence" | "endsClause" | "endsParagraph">> = {},
): Token {
  return {
    text,
    endsSentence: flags.endsSentence ?? false,
    endsClause: flags.endsClause ?? false,
    endsParagraph: flags.endsParagraph ?? false,
  };
}

describe("alignTokensToSource", () => {
  it("maps plain prose token ranges back to each token search key", () => {
    const source = "Alpha beta gamma.";
    const tokens = tokenize(source);
    const ranges = alignTokensToSource(source, tokens);
    const starts: number[] = [];

    ranges.forEach((range, index) => {
      expect(range).not.toBeNull();
      if (!range) return;
      expect(source.slice(range.start, range.end)).toBe(searchKey(tokens[index].text));
      starts.push(range.start);
    });

    expect(starts).toHaveLength(tokens.length);
    for (let i = 1; i < starts.length; i += 1) {
      expect(starts[i]).toBeGreaterThan(starts[i - 1]);
    }
  });

  it("maps markdown-stripped tokens to their source offsets", () => {
    const cases = [
      { source: "**bold** text", token: "bold", start: 2 },
      { source: "see [the docs](https://x.com)", token: "docs", start: 9 },
      { source: "[[target|Alias]]", token: "Alias", start: 9 },
      { source: "# Heading", token: "Heading", start: 2 },
      { source: "- item one", token: "item", start: 2 },
    ];

    for (const c of cases) {
      const tokens = tokenize(c.source);
      const ranges = alignTokensToSource(c.source, tokens);
      const index = tokens.findIndex((token) => token.text === c.token);

      expect(index).toBeGreaterThanOrEqual(0);
      expect(ranges[index]?.start).toBe(c.start);
      expect(c.source.slice(ranges[index]?.start, ranges[index]?.end)).toBe(c.token);
    }
  });

  it("maps repeated words to later source occurrences in order", () => {
    const source = "the cat sat on the mat";
    const tokens = tokenize(source);
    const ranges = alignTokensToSource(source, tokens);
    const theStarts = tokens
      .map((token, index) => ({ token, range: ranges[index] }))
      .filter(({ token }) => token.text === "the")
      .map(({ range }) => range?.start);

    expect(theStarts).toEqual([0, 15]);
  });

  it("returns null for absent tokens and handles empty token lists", () => {
    const missing: Token = {
      text: "missing",
      endsSentence: false,
      endsClause: false,
      endsParagraph: false,
    };
    const present: Token = {
      text: "present",
      endsSentence: false,
      endsClause: false,
      endsParagraph: false,
    };

    expect(alignTokensToSource("present text", [missing, present])).toEqual([
      null,
      { start: 0, end: 7 },
    ]);
    expect(alignTokensToSource("present text", [])).toEqual([]);
  });
});

describe("sentenceRangesByToken", () => {
  it("maps each token in two sentences to the full sentence source range", () => {
    const tokens = [
      token("Alpha"),
      token("beta.", { endsSentence: true }),
      token("Gamma"),
      token("delta.", { endsSentence: true }),
    ];
    const ranges: Array<SourceRange | null> = [
      { start: 0, end: 5 },
      { start: 6, end: 11 },
      { start: 12, end: 17 },
      { start: 18, end: 24 },
    ];

    expect(sentenceRangesByToken(tokens, ranges)).toEqual([
      { start: 0, end: 11 },
      { start: 0, end: 11 },
      { start: 12, end: 24 },
      { start: 12, end: 24 },
    ]);
  });

  it("treats paragraph ends as sentence breaks", () => {
    const tokens = [
      token("Alpha"),
      token("beta", { endsParagraph: true }),
      token("Gamma"),
      token("delta"),
    ];
    const ranges: Array<SourceRange | null> = [
      { start: 0, end: 5 },
      { start: 6, end: 10 },
      { start: 12, end: 17 },
      { start: 18, end: 23 },
    ];

    expect(sentenceRangesByToken(tokens, ranges)).toEqual([
      { start: 0, end: 10 },
      { start: 0, end: 10 },
      { start: 12, end: 23 },
      { start: 12, end: 23 },
    ]);
  });

  it("returns null for a sentence whose tokens all have null source ranges", () => {
    const tokens = [
      token("Missing"),
      token("sentence.", { endsSentence: true }),
      token("Located."),
    ];
    const ranges: Array<SourceRange | null> = [null, null, { start: 20, end: 28 }];

    expect(sentenceRangesByToken(tokens, ranges)).toEqual([
      null,
      null,
      { start: 20, end: 28 },
    ]);
  });

  it("maps a single sentence and handles empty input", () => {
    const tokens = [token("One"), token("sentence")];
    const ranges: Array<SourceRange | null> = [
      { start: 3, end: 6 },
      { start: 10, end: 18 },
    ];

    expect(sentenceRangesByToken(tokens, ranges)).toEqual([
      { start: 3, end: 18 },
      { start: 3, end: 18 },
    ]);
    expect(sentenceRangesByToken([], [])).toEqual([]);
  });
});

describe("sentenceTokenSpans", () => {
  it("maps every token to its sentence's token span", () => {
    const tokens = [
      token("One"),
      token("two."),
      token("Three"),
      token("four."),
    ];
    tokens[1].endsSentence = true;
    tokens[3].endsSentence = true;
    const spans = sentenceTokenSpans(tokens);
    expect(spans[0]).toEqual({ start: 0, end: 1 });
    expect(spans[1]).toEqual({ start: 0, end: 1 });
    expect(spans[2]).toEqual({ start: 2, end: 3 });
    expect(spans[3]).toEqual({ start: 2, end: 3 });
  });

  it("closes a trailing sentence without a flag and handles paragraph ends", () => {
    const tokens = [token("A", { endsParagraph: true }), token("b"), token("c")];
    const spans = sentenceTokenSpans(tokens);
    expect(spans[0]).toEqual({ start: 0, end: 0 });
    expect(spans[1]).toEqual({ start: 1, end: 2 });
    expect(spans[2]).toEqual({ start: 1, end: 2 });
    expect(sentenceTokenSpans([])).toEqual([]);
  });
});
