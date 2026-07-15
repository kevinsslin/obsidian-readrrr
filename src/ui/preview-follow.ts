/**
 * Sentence-level follow for Obsidian's Reading (preview) view.
 *
 * Reading view renders markdown to plain HTML with no sentence anchors and no
 * centered-scroll API, so this module works directly on the rendered DOM:
 *
 * 1. Index every text node under the preview root into one big string.
 * 2. Find the current sentence's words in that string (whitespace-flexible
 *    regex, forward-first search) and build a DOM Range over the match.
 * 3. Color the Range with OverlayMarks (plugin-drawn boxes; see that class
 *    for why the CSS Custom Highlight API is not used) and scroll the range's
 *    midpoint to the vertical center of the preview scroller.
 *
 * Everything degrades gracefully: an unrendered/virtualized block simply
 * reports a miss so the caller can fall back to a line-based jump and retry.
 */

export interface PreviewTextIndex {
  root: HTMLElement;
  text: string;
  nodes: Text[];
  /** starts[i] is the offset of nodes[i]'s first character within `text`. */
  starts: number[];
}

export interface TextSpan {
  start: number;
  end: number;
}

export function buildPreviewIndex(root: HTMLElement): PreviewTextIndex {
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  const starts: number[] = [];
  let text = "";
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (!node.data) continue;
    nodes.push(node);
    starts.push(text.length);
    text += node.data;
  }
  return { root, text, nodes, starts };
}

function escapeRegExp(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whitespace-flexible pattern for a run of words. */
function wordsPattern(words: string[]): string {
  return words.map(escapeRegExp).join("[\\s\\u00A0]+");
}

function execForward(pattern: string, text: string, from: number): TextSpan | null {
  const re = new RegExp(pattern, "g");
  re.lastIndex = Math.max(0, from);
  const m = re.exec(text);
  return m ? { start: m.index, end: m.index + m[0].length } : null;
}

function execFrom(pattern: string, text: string, from: number): TextSpan | null {
  const forward = execForward(pattern, text, from);
  if (forward) return forward;
  return from > 0 ? execForward(pattern, text, 0) : null;
}

/**
 * Find the sentence (given as its display words) in the indexed preview text.
 * Prefers a full match; falls back to bridging the first and last few words,
 * which tolerates small render differences (tags, footnote markers) inside the
 * sentence. Returns character offsets into `index.text`, or null.
 */
export function findSentenceSpan(
  index: PreviewTextIndex,
  words: string[],
  from: number,
): TextSpan | null {
  if (words.length === 0 || index.text.length === 0) return null;

  const full = execFrom(wordsPattern(words), index.text, from);
  if (full) return full;

  if (words.length >= 4) {
    const headWords = words.slice(0, 3);
    const tailWords = words.slice(-2);
    const head = execFrom(wordsPattern(headWords), index.text, from);
    if (head) {
      // The tail must come AFTER the head (forward-only, no wrap) and within a
      // bounded window, or the bridge is rejected entirely; a head-only match
      // is not trustworthy enough to highlight.
      const windowLimit = head.end + words.join(" ").length * 3 + 128;
      const tail = execForward(wordsPattern(tailWords), index.text, head.end);
      if (tail && tail.end <= windowLimit) return { start: head.start, end: tail.end };
    }
  }
  return null;
}

/**
 * Locate one word of a found sentence within that sentence's span. Words are
 * matched left to right (the same forward order used to find the sentence), so
 * a word repeated inside the sentence resolves to the right occurrence.
 * Returns offsets into `index.text`, or null when the word cannot be pinned
 * down (e.g. the sentence matched via the head/tail bridge and this word was
 * altered by rendering).
 */
export function findWordSpanInSentence(
  index: PreviewTextIndex,
  sentence: TextSpan,
  words: string[],
  wordIndex: number,
): TextSpan | null {
  if (wordIndex < 0 || wordIndex >= words.length) return null;
  let from = sentence.start;
  for (let i = 0; i <= wordIndex; i++) {
    const match = execForward(wordsPattern([words[i]]), index.text, from);
    if (!match || match.end > sentence.end) return null;
    if (i === wordIndex) return match;
    from = match.end;
  }
  return null;
}

function locate(index: PreviewTextIndex, offset: number): { node: Text; offset: number } | null {
  const { nodes, starts } = index;
  if (nodes.length === 0) return null;
  let lo = 0;
  let hi = nodes.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= offset) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const node = nodes[ans];
  const inner = Math.max(0, Math.min(offset - starts[ans], node.data.length));
  return { node, offset: inner };
}

/** Build a DOM Range over a span of the indexed text. */
export function rangeForSpan(index: PreviewTextIndex, span: TextSpan): Range | null {
  const startLoc = locate(index, span.start);
  const endLoc = locate(index, Math.max(span.start, span.end));
  if (!startLoc || !endLoc) return null;
  try {
    const range = index.root.ownerDocument.createRange();
    range.setStart(startLoc.node, startLoc.offset);
    range.setEnd(endLoc.node, endLoc.offset);
    return range;
  } catch {
    return null;
  }
}

export type MarkerStyle = "box" | "underline";

/**
 * The follow marks for one rendered-markdown surface: translucent sentence
 * boxes plus one persistent word marker, drawn as the plugin's own overlay
 * elements. Overlays are used instead of the CSS Custom Highlight API because
 * iOS WebKit fails to repaint a replaced highlight's old region (stale
 * highlights pile up on screen) and older iOS lacks the API entirely.
 *
 * The layer lives inside the surface's content element, so it scrolls with
 * the text, and it is re-created transparently when a re-render wipes it.
 * Uses only standard DOM APIs so it is unit-testable outside Obsidian.
 */
export class OverlayMarks {
  private container: HTMLElement | null = null;
  private layer: HTMLElement | null = null;
  private wordBox: HTMLElement | null = null;

  /** The layer must live inside `container` and survive its re-renders. */
  private ensureLayer(container: HTMLElement): HTMLElement {
    if (this.layer && this.layer.isConnected && this.container === container) {
      return this.layer;
    }
    this.layer?.remove();
    this.container = container;
    // Absolute mark positions need a positioned ancestor. Obsidian's preview
    // sizer and the reader's own pane already are; this guards other hosts.
    if (getComputedStyle(container).position === "static") {
      container.style.position = "relative";
    }
    const layer = container.ownerDocument.createElement("div");
    layer.className = "rsvp-reader-marks";
    container.appendChild(layer);
    this.layer = layer;
    this.wordBox = null;
    return layer;
  }

  /** Range.getClientRects is missing in some runtimes (jsdom); treat as none. */
  private static rectsOf(range: Range): DOMRect[] {
    return typeof range.getClientRects === "function" ? Array.from(range.getClientRects()) : [];
  }

  private place(el: HTMLElement, rect: DOMRect, base: DOMRect, underline: boolean): void {
    el.style.left = `${rect.left - base.left}px`;
    el.style.top = `${(underline ? rect.bottom - 3 : rect.top) - base.top}px`;
    el.style.width = `${rect.width}px`;
    el.style.height = underline ? "3px" : `${rect.height}px`;
  }

  /** Redraw the sentence tint boxes (call only when the sentence changes). */
  drawSentence(container: HTMLElement, range: Range): void {
    const layer = this.ensureLayer(container);
    layer.replaceChildren();
    this.wordBox = null;
    const base = container.getBoundingClientRect();
    for (const rect of OverlayMarks.rectsOf(range)) {
      if (rect.width <= 0 || rect.height <= 0) continue;
      const box = layer.ownerDocument.createElement("div");
      box.className = "rsvp-reader-mark rsvp-reader-mark-sentence";
      this.place(box, rect, base, false);
      layer.appendChild(box);
    }
  }

  /**
   * Move the single persistent word marker. Reusing one element lets CSS
   * transition its position, so the marker glides between words instead of
   * teleporting. The first placement after a redraw snaps (rr-snap).
   */
  moveWord(word: Range | null, style: MarkerStyle): void {
    if (!this.layer || !this.container) return;
    if (!word) {
      this.wordBox?.classList.add("rr-hidden");
      return;
    }
    const rect = OverlayMarks.rectsOf(word)[0];
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      this.wordBox?.classList.add("rr-hidden");
      return;
    }
    const base = this.container.getBoundingClientRect();
    let box = this.wordBox;
    const fresh = box === null;
    if (!box) {
      box = this.layer.ownerDocument.createElement("div");
      box.className = "rsvp-reader-mark rsvp-reader-mark-word rr-snap";
      if (style === "underline") box.classList.add("rsvp-reader-mark-underline");
      this.layer.appendChild(box);
      this.wordBox = box;
    }
    box.classList.remove("rr-hidden");
    this.place(box, rect, base, box.classList.contains("rsvp-reader-mark-underline"));
    if (fresh) {
      // Commit the snapped position, then allow gliding from the next move on.
      void box.offsetWidth;
      box.classList.remove("rr-snap");
    }
  }

  /** Toggle the locate pulse on the word marker. */
  setFlash(on: boolean): void {
    this.layer?.classList.toggle("rr-flash", on);
  }

  /** Hide the word marker only (the sentence tint stays). */
  hideWord(): void {
    this.wordBox?.classList.add("rr-hidden");
  }

  /** Run `fn` with the layer hidden (caretRangeFromPoint hit-tests overlays). */
  withHidden<T>(fn: () => T): T {
    const layer = this.layer;
    if (!layer) return fn();
    const display = layer.style.display;
    layer.style.display = "none";
    try {
      return fn();
    } finally {
      layer.style.display = display;
    }
  }

  clear(): void {
    this.layer?.remove();
    this.layer = null;
    this.wordBox = null;
    this.container = null;
  }
}

export interface PreviewHit {
  index: PreviewTextIndex;
  span: TextSpan;
  range: Range;
}

/**
 * Cached search state for following sentences through one rendered-markdown
 * surface (the note's Reading view, or the reader's embedded source pane).
 * Holds the text index plus the forward search position, and knows how to
 * rebuild when the surface re-renders under it.
 */
export class PreviewFollowState {
  private index: PreviewTextIndex | null = null;
  /** Next sentence search starts here (end of the last followed sentence). */
  searchFrom = 0;
  /** Span of the last successfully followed sentence. */
  lastSpan: TextSpan | null = null;

  reset(): void {
    this.index = null;
    this.searchFrom = 0;
    this.lastSpan = null;
  }

  /** Drop the cached text index (the surface re-rendered); keep positions. */
  invalidate(): void {
    this.index = null;
  }

  private attempt(index: PreviewTextIndex, words: string[], from: number): PreviewHit | null {
    const span = findSentenceSpan(index, words, from);
    if (!span) return null;
    const range = rangeForSpan(index, span);
    // A stale index (the surface re-renders as it scrolls) yields detached
    // nodes, which count as a miss so the caller rebuilds.
    if (!range || !range.startContainer.isConnected || !range.endContainer.isConnected) {
      return null;
    }
    return { index, span, range };
  }

  /** Find the sentence (as display words) in `root`, reusing the cached index. */
  find(root: HTMLElement, words: string[], from = this.searchFrom): PreviewHit | null {
    if (words.length === 0) return null;
    let index = this.index;
    let searchFrom = from;
    if (!index || index.root !== root) {
      index = buildPreviewIndex(root);
      searchFrom = 0;
    }
    let hit = this.attempt(index, words, searchFrom);
    if (!hit) {
      index = buildPreviewIndex(root);
      hit = this.attempt(index, words, 0);
    }
    this.index = index;
    return hit;
  }

  /**
   * Like find, but prefer the last followed location, so re-locating the
   * sentence the follower just lit resolves to the same occurrence even when
   * the sentence text repeats elsewhere in the note.
   */
  refind(root: HTMLElement, words: string[]): PreviewHit | null {
    return this.find(root, words, this.lastSpan?.start ?? this.searchFrom);
  }
}

/**
 * Scroll `scroller` so the range's midpoint sits at the vertical center.
 * Returns false when the range has no geometry yet (block not rendered).
 */
export function centerRangeInScroller(scroller: HTMLElement, range: Range): boolean {
  if (typeof range.getBoundingClientRect !== "function") return false;
  let rect: DOMRect;
  try {
    rect = range.getBoundingClientRect();
  } catch {
    return false;
  }
  if (rect.width === 0 && rect.height === 0) return false;
  const outer = scroller.getBoundingClientRect();
  const target =
    scroller.scrollTop + (rect.top - outer.top) + rect.height / 2 - scroller.clientHeight / 2;
  const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  const top = Math.max(0, Math.min(target, max));
  const reduceMotion =
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (typeof scroller.scrollTo === "function") {
    scroller.scrollTo({ top, behavior: reduceMotion ? "auto" : "smooth" });
  } else {
    scroller.scrollTop = top;
  }
  return true;
}
