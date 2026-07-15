// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import {
  buildPreviewIndex,
  findSentenceSpan,
  findWordSpanInSentence,
  rangeForSpan,
  centerRangeInScroller,
  OverlayMarks,
  PreviewFollowState,
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

describe("findWordSpanInSentence", () => {
  const words = ["the", "cat", "saw", "the", "dog."];

  function indexAndSentence() {
    const root = makeRoot("<p>Intro line. the cat saw the dog. More text.</p>");
    const index = buildPreviewIndex(root);
    const sentence = findSentenceSpan(index, words, 0)!;
    return { index, sentence };
  }

  it("finds each word at its offset within the sentence", () => {
    const { index, sentence } = indexAndSentence();
    const cat = findWordSpanInSentence(index, sentence, words, 1)!;
    expect(index.text.slice(cat.start, cat.end)).toBe("cat");
  });

  it("resolves a repeated word to the right occurrence", () => {
    const { index, sentence } = indexAndSentence();
    const firstThe = findWordSpanInSentence(index, sentence, words, 0)!;
    const secondThe = findWordSpanInSentence(index, sentence, words, 3)!;
    expect(index.text.slice(secondThe.start, secondThe.end)).toBe("the");
    expect(secondThe.start).toBeGreaterThan(firstThe.start);
  });

  it("returns null for an out-of-range word index", () => {
    const { index, sentence } = indexAndSentence();
    expect(findWordSpanInSentence(index, sentence, words, -1)).toBeNull();
    expect(findWordSpanInSentence(index, sentence, words, words.length)).toBeNull();
  });

  it("returns null when the word falls outside the sentence span", () => {
    const { index, sentence } = indexAndSentence();
    // "More" exists in the text but not inside the sentence's span.
    expect(findWordSpanInSentence(index, sentence, ["More"], 0)).toBeNull();
  });
});

describe("PreviewFollowState", () => {
  it("finds sentences and advances via searchFrom like the raw search", () => {
    const root = makeRoot("<p>alpha beta. alpha beta.</p>");
    const state = new PreviewFollowState();
    const first = state.find(root, ["alpha", "beta."])!;
    state.searchFrom = first.span.end;
    state.lastSpan = first.span;
    const second = state.find(root, ["alpha", "beta."])!;
    expect(second.span.start).toBeGreaterThan(first.span.start);
  });

  it("refind returns the last followed occurrence, not the first", () => {
    const root = makeRoot("<p>alpha beta. alpha beta.</p>");
    const state = new PreviewFollowState();
    const first = state.find(root, ["alpha", "beta."])!;
    state.searchFrom = first.span.end;
    const second = state.find(root, ["alpha", "beta."])!;
    state.searchFrom = second.span.end;
    state.lastSpan = second.span;
    // A plain find from searchFrom would wrap to the FIRST occurrence.
    const relocated = state.refind(root, ["alpha", "beta."])!;
    expect(relocated.span.start).toBe(second.span.start);
  });

  it("rebuilds its index when the surface re-renders (detached nodes)", () => {
    const root = makeRoot("<p>one two.</p>");
    const state = new PreviewFollowState();
    expect(state.find(root, ["one", "two."])).not.toBeNull();
    root.innerHTML = "<p>one two.</p>"; // same text, new nodes
    const hit = state.find(root, ["one", "two."])!;
    expect(hit.range.startContainer.isConnected).toBe(true);
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

describe("OverlayMarks", () => {
  function sentenceRange(root: HTMLElement): Range {
    const index = buildPreviewIndex(root);
    const span = findSentenceSpan(index, ["abc", "def."], 0)!;
    return rangeForSpan(index, span)!;
  }

  it("creates one marks layer inside the container and clears it", () => {
    const root = makeRoot("<p>abc def.</p>");
    const marks = new OverlayMarks();
    marks.drawSentence(root, sentenceRange(root));
    expect(root.querySelectorAll(".rsvp-reader-marks").length).toBe(1);
    marks.drawSentence(root, sentenceRange(root));
    expect(root.querySelectorAll(".rsvp-reader-marks").length).toBe(1);
    marks.clear();
    expect(root.querySelector(".rsvp-reader-marks")).toBeNull();
  });

  it("re-creates the layer after the container is wiped by a re-render", () => {
    const root = makeRoot("<p>abc def.</p>");
    const marks = new OverlayMarks();
    marks.drawSentence(root, sentenceRange(root));
    root.replaceChildren(); // simulated re-render
    root.innerHTML = "<p>abc def.</p>";
    marks.drawSentence(root, sentenceRange(root));
    const layers = root.querySelectorAll(".rsvp-reader-marks");
    expect(layers.length).toBe(1);
    expect(layers[0].isConnected).toBe(true);
  });

  it("hides the word marker for a null or zero-geometry word", () => {
    const root = makeRoot("<p>abc def.</p>");
    const marks = new OverlayMarks();
    marks.drawSentence(root, sentenceRange(root));
    // jsdom has no layout, so all rects are zero: the marker must stay hidden
    // rather than draw a zero-size box at 0,0.
    marks.moveWord(sentenceRange(root), "box");
    expect(root.querySelector(".rsvp-reader-mark-word")).toBeNull();
    expect(() => marks.moveWord(null, "box")).not.toThrow();
  });

  it("withHidden restores the layer's display even when fn throws", () => {
    const root = makeRoot("<p>abc def.</p>");
    const marks = new OverlayMarks();
    marks.drawSentence(root, sentenceRange(root));
    const layer = root.querySelector<HTMLElement>(".rsvp-reader-marks")!;
    expect(() =>
      marks.withHidden(() => {
        expect(layer.style.display).toBe("none");
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(layer.style.display).not.toBe("none");
  });

  it("toggles the flash class on the layer", () => {
    const root = makeRoot("<p>abc def.</p>");
    const marks = new OverlayMarks();
    marks.drawSentence(root, sentenceRange(root));
    marks.setFlash(true);
    expect(root.querySelector(".rsvp-reader-marks")!.classList.contains("rr-flash")).toBe(true);
    marks.setFlash(false);
    expect(root.querySelector(".rsvp-reader-marks")!.classList.contains("rr-flash")).toBe(false);
  });
});

describe("centering degrades gracefully", () => {
  it("reports false for a range with no geometry (unrendered)", () => {
    const root = makeRoot("<p>abc def.</p>");
    const index = buildPreviewIndex(root);
    const span = findSentenceSpan(index, ["abc", "def."], 0)!;
    const range = rangeForSpan(index, span)!;
    // jsdom has no layout: rects are zero, so centering reports false.
    expect(centerRangeInScroller(root, range)).toBe(false);
  });
});
