import { describe, it, expect } from "vitest";
import { buildUtterances, charIndexToRelToken } from "./chunker";
import type { Token } from "../core/types";

function tok(text: string, flags: Partial<Token> = {}): Token {
  return { text, endsSentence: false, endsClause: false, endsParagraph: false, ...flags };
}

describe("buildUtterances", () => {
  it("splits at sentence ends and records token/char offsets", () => {
    const tokens = [
      tok("One"),
      tok("two"),
      tok("three.", { endsSentence: true }),
      tok("Four"),
      tok("five.", { endsSentence: true }),
    ];
    const u = buildUtterances(tokens);
    expect(u).toHaveLength(2);

    expect(u[0]).toEqual({
      text: "One two three.",
      tokenStart: 0,
      tokenCount: 3,
      charStarts: [0, 4, 8],
    });
    expect(u[1]).toEqual({
      text: "Four five.",
      tokenStart: 3,
      tokenCount: 2,
      charStarts: [0, 5],
    });
  });

  it("splits at paragraph ends too", () => {
    const tokens = [tok("A", { endsParagraph: true }), tok("B")];
    const u = buildUtterances(tokens);
    expect(u.map((x) => x.text)).toEqual(["A", "B"]);
  });

  it("caps chunk size at maxTokensPerChunk", () => {
    const tokens = [tok("a"), tok("b"), tok("c"), tok("d"), tok("e")];
    const u = buildUtterances(tokens, { maxTokensPerChunk: 2 });
    expect(u.map((x) => x.tokenCount)).toEqual([2, 2, 1]);
    expect(u.map((x) => x.tokenStart)).toEqual([0, 2, 4]);
  });

  it("returns nothing for no tokens", () => {
    expect(buildUtterances([])).toEqual([]);
  });
});

describe("charIndexToRelToken", () => {
  it("maps a char index to the token whose span contains it", () => {
    const starts = [0, 4, 8];
    expect(charIndexToRelToken(starts, 0)).toBe(0);
    expect(charIndexToRelToken(starts, 3)).toBe(0);
    expect(charIndexToRelToken(starts, 4)).toBe(1);
    expect(charIndexToRelToken(starts, 7)).toBe(1);
    expect(charIndexToRelToken(starts, 8)).toBe(2);
    expect(charIndexToRelToken(starts, 999)).toBe(2);
  });

  it("clamps a negative index to the first token and handles empty input", () => {
    expect(charIndexToRelToken([0, 4], -5)).toBe(0);
    expect(charIndexToRelToken([], 3)).toBe(0);
  });
});
