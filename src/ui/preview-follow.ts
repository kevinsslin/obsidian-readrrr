/**
 * Sentence-level follow for Obsidian's Reading (preview) view.
 *
 * Reading view renders markdown to plain HTML with no sentence anchors and no
 * centered-scroll API, so this module works directly on the rendered DOM:
 *
 * 1. Index every text node under the preview root into one big string.
 * 2. Find the current sentence's words in that string (whitespace-flexible
 *    regex, forward-first search) and build a DOM Range over the match.
 * 3. Color the Range with the CSS Custom Highlight API (no DOM mutation, so
 *    Obsidian's renderer is never disturbed) and scroll the range's midpoint
 *    to the vertical center of the preview scroller.
 *
 * Everything degrades gracefully: without CSS.highlights there is no color
 * (scrolling still works), and an unrendered/virtualized block simply reports
 * a miss so the caller can fall back to a line-based jump and retry.
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

const HIGHLIGHT_KEY = "rsvp-reader-sentence";

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

interface HighlightRegistry {
  set(key: string, highlight: unknown): void;
  delete(key: string): boolean;
}

function highlightRegistry(): HighlightRegistry | null {
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS;
  return css?.highlights ?? null;
}

type HighlightConstructor = new (...ranges: Range[]) => unknown;

function highlightCtor(): HighlightConstructor | null {
  return (globalThis as { Highlight?: HighlightConstructor }).Highlight ?? null;
}

/** True when the CSS Custom Highlight API is available in this runtime. */
export function canHighlight(): boolean {
  return highlightRegistry() !== null && highlightCtor() !== null;
}

/** Color the range via the CSS Custom Highlight API; null clears the color. */
export function applySentenceHighlight(range: Range | null): void {
  const registry = highlightRegistry();
  const Ctor = highlightCtor();
  if (!registry || !Ctor) return;
  if (range) registry.set(HIGHLIGHT_KEY, new Ctor(range));
  else registry.delete(HIGHLIGHT_KEY);
}

export function clearSentenceHighlight(): void {
  applySentenceHighlight(null);
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
