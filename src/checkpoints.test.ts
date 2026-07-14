import { describe, expect, it } from "vitest";
import { alignTokensToSource, type SourceRange } from "./core/align";
import { tokenize } from "./core/tokenizer";
import type { Token } from "./core/types";
import { createCheckpoint, isReadingCheckpoint, resolveCheckpoint } from "./checkpoints";

function tokens(...texts: string[]): Token[] {
  return texts.map((text) => ({
    text,
    endsSentence: false,
    endsClause: false,
    endsParagraph: false,
  }));
}

function ranges(items: Token[]): SourceRange[] {
  let cursor = 0;
  return items.map((token) => {
    const range = { start: cursor, end: cursor + token.text.length };
    cursor = range.end + 1;
    return range;
  });
}

describe("reading checkpoints", () => {
  it("creates and restores an unchanged checkpoint", () => {
    const items = tokens("one", "two", "three", "four");
    const checkpoint = createCheckpoint("Book.md", items, ranges(items), 2, 123)!;
    expect(checkpoint).toMatchObject({
      filePath: "Book.md",
      tokenIndex: 2,
      totalTokens: 4,
      currentToken: "three",
      previousToken: "two",
      nextToken: "four",
      updatedAt: 123,
    });
    expect(resolveCheckpoint(checkpoint, items, ranges(items))).toBe(2);
  });

  it("finds the anchored token after text is inserted before it", () => {
    const original = tokens("one", "two", "chapter", "target", "continues");
    const checkpoint = createCheckpoint("Book.md", original, ranges(original), 3)!;
    const edited = tokens("new", "preface", ...original.map((token) => token.text));
    expect(resolveCheckpoint(checkpoint, edited, ranges(edited))).toBe(5);
  });

  it("uses nearby context to disambiguate repeated words", () => {
    const original = tokens("first", "the", "middle", "second", "the", "ending");
    const checkpoint = createCheckpoint("Book.md", original, ranges(original), 4)!;
    const edited = tokens("the", "first", "the", "middle", "second", "the", "ending");
    expect(resolveCheckpoint(checkpoint, edited, ranges(edited))).toBe(5);
  });

  it("falls back to the nearest source offset when anchor text changed", () => {
    const original = tokens("one", "old", "three");
    const checkpoint = createCheckpoint("Book.md", original, ranges(original), 1)!;
    const edited = tokens("one", "replacement", "three");
    expect(resolveCheckpoint(checkpoint, edited, ranges(edited))).toBe(1);
  });

  it("falls back to proportional progress without usable source ranges", () => {
    const original = tokens("one", "two", "three", "four", "five");
    const checkpoint = createCheckpoint("Book.md", original, ranges(original), 2)!;
    const edited = tokens("a", "b", "c", "d", "e", "f", "g", "h", "i");
    expect(resolveCheckpoint(checkpoint, edited, new Array(edited.length).fill(null))).toBe(4);
  });

  it("preserves an anchor when live tokenizer settings remove earlier content", () => {
    const source = "before\n```txt\nignored code words\n```\nafter target";
    const original = tokenize(source, { skipCodeBlocks: false, skipFrontmatter: true });
    const originalRanges = alignTokensToSource(source, original);
    const targetIndex = original.findIndex((token) => token.text === "target");
    const checkpoint = createCheckpoint(
      "Book.md",
      original,
      originalRanges,
      targetIndex,
    )!;

    const retokenized = tokenize(source, { skipCodeBlocks: true, skipFrontmatter: true });
    const retokenizedRanges = alignTokensToSource(source, retokenized);
    const restored = resolveCheckpoint(checkpoint, retokenized, retokenizedRanges);
    expect(retokenized[restored].text).toBe("target");
  });

  it("does not create a checkpoint for empty content", () => {
    expect(createCheckpoint("Empty.md", [], [], 0)).toBeNull();
  });

  it("rejects malformed persisted numeric fields", () => {
    const items = tokens("one", "two", "three");
    const valid = createCheckpoint("Book.md", items, ranges(items), 1, 123)!;
    expect(isReadingCheckpoint(valid)).toBe(true);

    const invalid = [
      { tokenIndex: Number.NaN },
      { tokenIndex: 1.5 },
      { tokenIndex: -1 },
      { tokenIndex: 3 },
      { totalTokens: Number.POSITIVE_INFINITY },
      { totalTokens: 0 },
      { totalTokens: 1 },
      { progress: Number.NaN },
      { progress: -0.01 },
      { progress: 1.01 },
      { sourceOffset: Number.POSITIVE_INFINITY },
      { sourceOffset: 1.5 },
      { sourceOffset: -1 },
      { updatedAt: Number.NaN },
      { updatedAt: -1 },
    ];
    for (const patch of invalid) {
      expect(isReadingCheckpoint({ ...valid, ...patch })).toBe(false);
    }
  });
});
