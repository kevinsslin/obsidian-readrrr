// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import {
  buildPreviewIndex,
  findSentenceSpan,
  rangeForSpan,
  centerRangeInScroller,
  applySentenceHighlight,
  canHighlight,
} from "./preview-follow";

function makeRoot(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

describe("buildPreviewIndex", () => {
  it("indexes all text nodes with their offsets", () => {
    const root = makeRoot("<p>Hello <strong>bold</strong> world.</p><p>Next block.</p>");
    const index = buildPreviewIndex(root);
    expect(index.text).toBe("Hello bold world.Next block.");
    expect(index.nodes.length).toBe(4);
    expect(index.starts[0]).toBe(0);
    // "bold" starts after "Hello "
    expect(index.starts[1]).toBe(6);
  });

  it("handles an empty root", () => {
    const index = buildPreviewIndex(makeRoot(""));
    expect(index.text).toBe("");
    expect(findSentenceSpan(index, ["anything"], 0)).toBeNull();
  });
});

describe("findSentenceSpan", () => {
  it("finds a sentence across inline element boundaries", () => {
    const root = makeRoot("<p>The <em>quick</em> brown fox. Second sentence here.</p>");
    const index = buildPreviewIndex(root);
    const span = findSentenceSpan(index, ["The", "quick", "brown", "fox."], 0);
    expect(span).not.toBeNull();
    expect(index.text.slice(span!.start, span!.end)).toBe("The quick brown fox.");
  });

  it("searches forward first, wrapping to the start when needed", () => {
    const root = makeRoot("<p>alpha beta. alpha beta.</p>");
    const index = buildPreviewIndex(root);
    const first = findSentenceSpan(index, ["alpha", "beta."], 0)!;
    const second = findSentenceSpan(index, ["alpha", "beta."], first.start + 1)!;
    expect(second.start).toBeGreaterThan(first.start);
    // From past the last occurrence it wraps back to the first.
    const wrapped = findSentenceSpan(index, ["alpha", "beta."], second.start + 1)!;
    expect(wrapped.start).toBe(first.start);
  });

  it("escapes regex metacharacters in words", () => {
    const root = makeRoot("<p>Use C++ (fast) today.</p>");
    const index = buildPreviewIndex(root);
    const span = findSentenceSpan(index, ["Use", "C++", "(fast)", "today."], 0);
    expect(span).not.toBeNull();
    expect(index.text.slice(span!.start, span!.end)).toBe("Use C++ (fast) today.");
  });

  it("bridges head and tail when the middle differs slightly", () => {
    // Rendered text has an extra marker the tokens do not know about.
    const root = makeRoot("<p>One two three FOUR five six seven.</p>");
    const index = buildPreviewIndex(root);
    const span = findSentenceSpan(
      index,
      ["One", "two", "three", "4", "five", "six", "seven."],
      0,
    );
    expect(span).not.toBeNull();
    const text = index.text.slice(span!.start, span!.end);
    expect(text.startsWith("One two three")).toBe(true);
    expect(text.endsWith("six seven.")).toBe(true);
  });

  it("rejects a bridge whose tail only exists before the head (no wrap)", () => {
    // "six seven." appears only BEFORE the head words; bridging must fail
    // rather than produce a reversed or head-only span.
    const root = makeRoot("<p>six seven. One two three FOUR five.</p>");
    const index = buildPreviewIndex(root);
    const span = findSentenceSpan(
      index,
      ["One", "two", "three", "4", "five", "six", "seven."],
      0,
    );
    expect(span).toBeNull();
  });

  it("finds the second identical sentence when searching from the first's end", () => {
    const root = makeRoot("<p>alpha beta. alpha beta.</p>");
    const index = buildPreviewIndex(root);
    const first = findSentenceSpan(index, ["alpha", "beta."], 0)!;
    const second = findSentenceSpan(index, ["alpha", "beta."], first.end)!;
    expect(second.start).toBeGreaterThan(first.start);
  });

  it("returns null when the sentence is absent", () => {
    const root = makeRoot("<p>Nothing to see.</p>");
    const index = buildPreviewIndex(root);
    expect(findSentenceSpan(index, ["missing", "sentence", "entirely", "gone", "now"], 0)).toBeNull();
  });
});

describe("rangeForSpan", () => {
  it("builds a DOM range whose text matches the span", () => {
    const root = makeRoot("<p>Hello <strong>bold</strong> world.</p>");
    const index = buildPreviewIndex(root);
    const span = findSentenceSpan(index, ["Hello", "bold", "world."], 0)!;
    const range = rangeForSpan(index, span)!;
    expect(range.toString()).toBe("Hello bold world.");
  });
});

describe("highlight + centering degrade gracefully", () => {
  it("is a no-op without the CSS Custom Highlight API (jsdom)", () => {
    expect(canHighlight()).toBe(false);
    const root = makeRoot("<p>abc def.</p>");
    const index = buildPreviewIndex(root);
    const span = findSentenceSpan(index, ["abc", "def."], 0)!;
    const range = rangeForSpan(index, span)!;
    expect(() => applySentenceHighlight(range)).not.toThrow();
    expect(() => applySentenceHighlight(null)).not.toThrow();
  });

  it("reports false for a range with no geometry (unrendered)", () => {
    const root = makeRoot("<p>abc def.</p>");
    const index = buildPreviewIndex(root);
    const span = findSentenceSpan(index, ["abc", "def."], 0)!;
    const range = rangeForSpan(index, span)!;
    // jsdom has no layout: rects are zero, so centering reports false.
    expect(centerRangeInScroller(root, range)).toBe(false);
  });
});
