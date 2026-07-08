import { ItemView, MarkdownView, Notice, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import type { EditorView } from "@codemirror/view";
import type RsvpReaderPlugin from "../main";
import { Reader, type ReaderState } from "../reader/reader";
import { tokenize } from "../core/tokenizer";
import {
  alignTokensToSource,
  sentenceRangesByToken,
  sentenceTokenSpans,
  type SourceRange,
  type TokenSpan,
} from "../core/align";
import type { Token } from "../core/types";
import type { OrpSplit } from "../core/orp";
import { toTimingOptions, toTokenizeOptions, toSpeakOptions } from "../settings";
import { highlightInEditor } from "./note-highlight";
import {
  buildPreviewIndex,
  findSentenceSpan,
  rangeForSpan,
  applySentenceHighlight,
  clearSentenceHighlight,
  centerRangeInScroller,
  type PreviewTextIndex,
} from "./preview-follow";

export const VIEW_TYPE_RSVP_READER = "rsvp-reader-view";

const MIN_WPM = 100;
const MAX_WPM = 1000;

function clampWpm(value: number): number {
  return Math.min(MAX_WPM, Math.max(MIN_WPM, Math.round(value)));
}

/** The reading pane: a fixed-point RSVP display plus transport controls. */
export class RsvpView extends ItemView {
  private readonly plugin: RsvpReaderPlugin;
  private readonly reader: Reader;
  private state: ReaderState = { status: "idle", index: 0, total: 0 };
  private title = "";
  private sourceText: string | null = null;
  private sourceFile: TFile | null = null;
  private tokens: Token[] = [];
  private tokenRanges: Array<SourceRange | null> = [];
  private sentenceRanges: Array<SourceRange | null> = [];
  private sentenceSpans: TokenSpan[] = [];
  private lastNoteFollowRange: SourceRange | null | undefined = undefined;
  private lastNoteFollowView: MarkdownView | null = null;
  private lastNoteFollowMode: string | null = null;
  private tokenizeKey = "";
  private holdTimer: number | null = null;
  private narrationApplyTimer: number | null = null;
  private paddedEditorDom: HTMLElement | null = null;
  private previewIndex: PreviewTextIndex | null = null;
  private previewSearchFrom = 0;
  private lastPreviewMissLine: number | null = null;

  private root!: HTMLElement;
  private titleEl!: HTMLElement;
  private stageEl!: HTMLElement;
  private wordEl!: HTMLElement;
  private beforeEl!: HTMLElement;
  private pivotEl!: HTMLElement;
  private afterEl!: HTMLElement;
  private emptyEl!: HTMLElement;
  private progressFillEl!: HTMLElement;
  private progressKnobEl!: HTMLElement;
  private counterEl!: HTMLElement;
  private playBtn!: HTMLButtonElement;
  private narrateBtn!: HTMLButtonElement;
  private followBtn!: HTMLButtonElement;
  private wpmBarEl!: HTMLElement;
  private wpmInput!: HTMLInputElement;
  private wpmValueEl!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, plugin: RsvpReaderPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.reader = new Reader();
    this.reader.setListeners({
      onWord: (_entry, split) => this.renderWord(split),
      onState: (state) => this.renderState(state),
      onFinish: () => this.root.addClass("is-finished"),
    });
  }

  getViewType(): string {
    return VIEW_TYPE_RSVP_READER;
  }

  getDisplayText(): string {
    return this.title ? `Reading: ${this.title}` : "RSVP Reader";
  }

  getIcon(): string {
    return "gauge";
  }

  async onOpen(): Promise<void> {
    this.root = this.contentEl;
    this.root.empty();
    this.root.addClass("rsvp-reader-view");
    this.root.setAttr("tabindex", "0");
    this.buildDom();
    this.applySettings();
    this.showEmpty("Run “RSVP Reader: read current note” to start.");
    this.registerDomEvent(this.root, "keydown", (e) => this.onKeyDown(e));
    // Guarantee teardown even if onClose is skipped (e.g. plugin unload).
    this.register(() => this.reader.destroy());
  }

  async onClose(): Promise<void> {
    this.dispose();
  }

  /** Release timers and audio without removing the pane (used on plugin unload). */
  dispose(): void {
    this.clearNoteFollow();
    if (this.holdTimer !== null) {
      window.clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
    if (this.narrationApplyTimer !== null) {
      window.clearTimeout(this.narrationApplyTimer);
      this.narrationApplyTimer = null;
    }
    this.reader.destroy();
  }

  /** Load text into the reader and reset to the first word. */
  setContent(text: string, title: string, file: TFile | null = null): void {
    this.clearNoteFollow();
    this.title = title;
    this.titleEl.setText(title);
    this.root.removeClass("is-finished");
    this.sourceText = text;
    this.sourceFile = file;
    this.updateFollowButton();
    this.followBtn.toggleClass("rr-hidden", !file);
    this.tokenizeKey = JSON.stringify(toTokenizeOptions(this.plugin.settings));
    const tokens = tokenize(text, toTokenizeOptions(this.plugin.settings));
    this.setTokenData(tokens, text);
    this.reader.load(tokens, toTimingOptions(this.plugin.settings));
    this.updateNoteFollow();
    if (tokens.length === 0) {
      this.showEmpty("Nothing readable in this note.");
      return;
    }
    this.applyNarration();
    this.root.focus();
  }

  /** Re-apply plugin settings to a live reader (called when settings change). */
  applySettings(): void {
    this.root.style.setProperty("--rr-font-size", `${this.plugin.settings.fontSize}px`);
    this.wpmBarEl.toggleClass("rr-hidden", !this.plugin.settings.showWpmBar);
    this.wpmInput.value = String(this.plugin.settings.wpm);
    this.wpmValueEl.setText(`${this.plugin.settings.wpm} wpm`);
    this.updateFollowButton();
    if (!this.plugin.settings.followInNote) this.clearNoteFollow();

    // Content settings (skip code/frontmatter) change the token set, so
    // re-tokenize, but only when they actually changed, so a WPM or font tweak
    // does not reset the reading position.
    const key = JSON.stringify(toTokenizeOptions(this.plugin.settings));
    if (this.sourceText !== null && key !== this.tokenizeKey) {
      this.tokenizeKey = key;
      const tokens = tokenize(this.sourceText, toTokenizeOptions(this.plugin.settings));
      this.setTokenData(tokens, this.sourceText);
      this.reader.load(tokens, toTimingOptions(this.plugin.settings));
      if (tokens.length === 0) this.showEmpty("Nothing readable in this note.");
    } else {
      this.reader.setTiming(toTimingOptions(this.plugin.settings));
    }

    // A word-size change alters the natural width, so refit the current word.
    this.fitWord();

    // Settings sliders fire continuously while dragging; debounce the audio
    // restart (the narrate button state itself is updated inside).
    this.applyNarrationSoon();
    this.updateNoteFollow();
  }

  /**
   * Debounced narration re-apply, for paths that can fire in bursts (settings
   * sliders mid-drag, held speed keys). The reader also skips restarts when
   * nothing audible changed, so together a burst costs at most one restart.
   */
  private applyNarrationSoon(): void {
    if (this.narrationApplyTimer !== null) window.clearTimeout(this.narrationApplyTimer);
    this.narrationApplyTimer = window.setTimeout(() => {
      this.narrationApplyTimer = null;
      this.applyNarration();
    }, 250);
  }

  private applyNarration(): void {
    const provider = this.plugin.getProvider();
    if (this.plugin.settings.narrate && provider) {
      this.reader.setNarration({ provider, speak: toSpeakOptions(this.plugin.settings) });
      this.narrateBtn.addClass("rr-btn-active");
    } else {
      this.reader.setNarration(null);
      this.narrateBtn.removeClass("rr-btn-active");
    }
    this.narrateBtn.toggleClass("rr-hidden", !provider);
  }

  // ---- DOM ----

  private buildDom(): void {
    this.titleEl = this.root.createDiv({ cls: "rr-title" });

    const stage = this.root.createDiv({ cls: "rr-stage" });
    this.stageEl = stage;
    stage.createDiv({ cls: "rr-guide rr-guide-top" });
    stage.createDiv({ cls: "rr-guide rr-guide-bottom" });
    this.wordEl = stage.createDiv({ cls: "rr-word" });
    this.beforeEl = this.wordEl.createSpan({ cls: "rr-before" });
    this.pivotEl = this.wordEl.createSpan({ cls: "rr-pivot" });
    this.afterEl = this.wordEl.createSpan({ cls: "rr-after" });
    this.emptyEl = stage.createDiv({ cls: "rr-empty" });
    this.setupStageGesture(stage);

    // Re-fit the current word whenever the pane changes size (a narrow split,
    // a resized window, or a phone in either orientation).
    const resizeObserver = new ResizeObserver(() => this.fitWord());
    resizeObserver.observe(stage);
    this.register(() => resizeObserver.disconnect());

    const progress = this.root.createDiv({ cls: "rr-progress" });
    this.progressFillEl = progress.createDiv({ cls: "rr-progress-fill" });
    this.progressKnobEl = progress.createDiv({ cls: "rr-progress-knob" });
    this.setupScrub(progress);

    const controls = this.root.createDiv({ cls: "rr-controls" });
    this.makeButton(controls, "rotate-ccw", "Restart", () => this.reader.stop());
    this.makeButton(controls, "chevrons-left", "Previous sentence", () =>
      this.reader.seekBySentence(-1),
    );
    this.playBtn = this.makeButton(controls, "play", "Play / pause", () => this.reader.toggle(), true);
    this.makeButton(controls, "chevrons-right", "Next sentence", () =>
      this.reader.seekBySentence(1),
    );
    this.narrateBtn = this.makeButton(controls, "volume-2", "Toggle narration", () =>
      this.toggleNarration(),
    );
    this.followBtn = this.makeButton(controls, "file-text", "Follow in note", () =>
      void this.toggleFollowInNote(),
    );
    this.updateFollowButton();
    this.followBtn.addClass("rr-hidden");
    this.counterEl = controls.createDiv({ cls: "rr-counter", text: "0 / 0" });

    this.wpmBarEl = this.root.createDiv({ cls: "rr-wpm-bar" });
    this.wpmBarEl.createSpan({ text: "Speed" });
    this.wpmInput = this.wpmBarEl.createEl("input", { type: "range" });
    this.wpmInput.min = String(MIN_WPM);
    this.wpmInput.max = String(MAX_WPM);
    this.wpmInput.step = "10";
    this.wpmValueEl = this.wpmBarEl.createSpan({ cls: "rr-wpm-value", text: "250 wpm" });
    // Update the visual pace live while dragging; commit and re-rate narration
    // when the drag ends (Web Speech cannot change rate mid-utterance).
    this.registerDomEvent(this.wpmInput, "input", () => {
      this.setWpm(Number(this.wpmInput.value), false);
    });
    this.registerDomEvent(this.wpmInput, "change", () => {
      this.setWpm(Number(this.wpmInput.value), true);
      this.applyNarration();
    });
  }

  private updateFollowButton(): void {
    this.followBtn.toggleClass("rr-btn-active", this.plugin.settings.followInNote);
  }

  private makeButton(
    parent: HTMLElement,
    icon: string,
    label: string,
    onClick: () => void,
    primary = false,
  ): HTMLButtonElement {
    const btn = parent.createEl("button", {
      cls: primary ? "rr-btn rr-btn-primary" : "rr-btn",
    });
    btn.setAttr("aria-label", label);
    btn.setAttr("title", label);
    setIcon(btn, icon);
    this.registerDomEvent(btn, "click", (e) => {
      e.preventDefault();
      onClick();
      this.root.focus();
    });
    return btn;
  }

  /** Make the progress bar a click/drag scrubber (mouse and touch). */
  private setupScrub(bar: HTMLElement): void {
    let activePointer: number | null = null;
    let wasPlaying = false;

    const seekAt = (clientX: number): void => {
      const total = this.state.total;
      if (total <= 0) return;
      const rect = bar.getBoundingClientRect();
      if (rect.width <= 0) return;
      const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      this.reader.seekToIndex(Math.round(frac * (total - 1)));
    };

    const finish = (): void => {
      if (activePointer === null) return;
      activePointer = null;
      bar.removeClass("rr-scrubbing");
      if (wasPlaying) {
        wasPlaying = false;
        this.reader.play(); // resume at the released position
      }
      this.root.focus();
    };

    this.registerDomEvent(bar, "pointerdown", (e) => {
      if (activePointer !== null || this.state.total <= 0) return;
      activePointer = e.pointerId;
      // Pause during the drag so we don't restart narration on every move.
      wasPlaying = this.state.status === "playing";
      if (wasPlaying) this.reader.pause();
      bar.addClass("rr-scrubbing");
      bar.setPointerCapture(e.pointerId);
      seekAt(e.clientX);
      e.preventDefault();
    });
    this.registerDomEvent(bar, "pointermove", (e) => {
      if (e.pointerId === activePointer) seekAt(e.clientX);
    });
    this.registerDomEvent(bar, "pointerup", (e) => {
      if (e.pointerId !== activePointer) return;
      seekAt(e.clientX); // honor the exact release position
      finish();
    });
    this.registerDomEvent(bar, "pointercancel", (e) => {
      if (e.pointerId === activePointer) finish();
    });
    // If capture is lost without a normal release, still clean up and resume.
    this.registerDomEvent(bar, "lostpointercapture", (e) => {
      if (e.pointerId === activePointer) finish();
    });
  }

  /**
   * Tap the word area to toggle play/pause; press and hold to read while held
   * and pause on release ("hold to read, release to see where you are"). The
   * word, counter, and progress mark your position.
   */
  private setupStageGesture(stage: HTMLElement): void {
    const HOLD_MS = 220;
    let activePointer: number | null = null;
    let holding = false;
    let holdStartedPlayback = false;

    const end = (commitTap: boolean): void => {
      if (this.holdTimer !== null) {
        // Released before the hold threshold: treat as a tap (toggle).
        window.clearTimeout(this.holdTimer);
        this.holdTimer = null;
        if (commitTap && this.state.total > 0) this.reader.toggle();
      } else if (holding && holdStartedPlayback) {
        // The hold started playback, so releasing pauses where it landed. A
        // hold that began while already playing leaves playback untouched.
        this.reader.pause();
      }
      holding = false;
      holdStartedPlayback = false;
      activePointer = null;
      this.root.focus();
    };

    this.registerDomEvent(stage, "pointerdown", (e) => {
      if (activePointer !== null || this.state.total <= 0) return;
      activePointer = e.pointerId;
      holding = false;
      holdStartedPlayback = false;
      stage.setPointerCapture(e.pointerId);
      this.holdTimer = window.setTimeout(() => {
        this.holdTimer = null;
        holding = true;
        if (this.state.status !== "playing") {
          holdStartedPlayback = true;
          this.reader.play();
        }
      }, HOLD_MS);
      e.preventDefault();
    });
    this.registerDomEvent(stage, "pointerup", (e) => {
      if (e.pointerId === activePointer) end(true);
    });
    this.registerDomEvent(stage, "pointercancel", (e) => {
      if (e.pointerId === activePointer) end(false);
    });
    this.registerDomEvent(stage, "lostpointercapture", (e) => {
      if (e.pointerId === activePointer) end(false);
    });
    // Suppress the long-press context menu / text selection during the gesture.
    this.registerDomEvent(stage, "contextmenu", (e) => e.preventDefault());
  }

  // ---- rendering ----

  private renderWord(split: OrpSplit): void {
    this.emptyEl.addClass("rr-hidden");
    this.wordEl.removeClass("rr-hidden");
    this.beforeEl.setText(split.before);
    this.pivotEl.setText(split.pivot);
    this.afterEl.setText(split.after);
    this.fitWord();
  }

  /**
   * Scale the current word down so it always fits the pane, however narrow (a
   * side split, a small window, or a phone). The word-size setting is the
   * target for short words; anything wider shrinks to fit.
   *
   * The word is anchored at the pivot letter, which sits on the stage center,
   * so it hangs asymmetrically around that line: a short run before the pivot
   * on the left, a longer run after it on the right. The longer side is what
   * clips first, so fit to that side's extent from the center, not the total
   * width. The transform-origin is the stage center (the anchor column), so
   * the pivot stays fixed while the word shrinks around it.
   */
  private fitWord(): void {
    if (!this.stageEl || this.wordEl.hasClass("rr-hidden")) return;
    const available = this.stageEl.clientWidth;
    if (available <= 0) return;
    // offsetWidth ignores CSS transforms, so these are the untransformed widths
    // regardless of any scale still applied from the previous word.
    const pivotHalf = this.pivotEl.offsetWidth / 2;
    const maxExtent = Math.max(
      this.beforeEl.offsetWidth + pivotHalf,
      this.afterEl.offsetWidth + pivotHalf,
    );
    // Each side gets half the pane; 0.48 rather than 0.5 leaves a little
    // breathing room. Math.min keeps short words at full size with no jump at
    // the threshold.
    const scale = maxExtent > 0 ? Math.min(1, (available * 0.48) / maxExtent) : 1;
    this.wordEl.style.transform = scale < 1 ? `scale(${scale})` : "";
  }

  private renderState(state: ReaderState): void {
    const previousStatus = this.state.status;
    this.state = state;
    setIcon(this.playBtn, state.status === "playing" ? "pause" : "play");
    this.counterEl.setText(state.total > 0 ? `${state.index + 1} / ${state.total}` : "0 / 0");
    // Use the same coordinate as the scrubber (index / (total - 1)) so the knob
    // sits exactly where a click at that spot would seek to.
    const pct = state.total > 1 ? (state.index / (state.total - 1)) * 100 : 0;
    this.progressFillEl.style.width = `${pct}%`;
    this.progressKnobEl.style.left = `${pct}%`;
    if (state.status !== "finished") this.root.removeClass("is-finished");
    if (state.status === "idle" && previousStatus !== "idle") this.clearNoteFollow();
    this.updateNoteFollow();
  }

  private showEmpty(message: string): void {
    this.wordEl.addClass("rr-hidden");
    this.emptyEl.removeClass("rr-hidden");
    this.emptyEl.setText(message);
    this.counterEl.setText("0 / 0");
    this.progressFillEl.style.width = "0%";
    this.progressKnobEl.style.left = "0%";
  }

  private sourceMarkdownView(): MarkdownView | null {
    const file = this.sourceFile;
    if (!file) return null;
    if (!(this.app.vault.getAbstractFileByPath(file.path) instanceof TFile)) return null;

    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) continue;
      if (view.file?.path !== file.path) continue;
      return view;
    }

    return null;
  }

  private sourceEditorView(): EditorView | null {
    const file = this.sourceFile;
    if (!file) return null;
    if (!(this.app.vault.getAbstractFileByPath(file.path) instanceof TFile)) return null;

    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) continue;
      if (view.file?.path !== file.path) continue;
      if (view.getMode() !== "source") continue;
      return (view.editor as unknown as { cm?: EditorView }).cm ?? null;
    }

    return null;
  }

  private async ensureNoteOpen(): Promise<void> {
    const file = this.sourceFile;
    if (!file) return;
    if (!(this.app.vault.getAbstractFileByPath(file.path) instanceof TFile)) {
      new Notice("RSVP Reader: the source note is no longer available.");
      return;
    }
    if (this.sourceMarkdownView()) return;

    try {
      await this.app.workspace.getLeaf(false).openFile(file, { active: false });
    } catch {
      new Notice("RSVP Reader: could not open the source note.");
    }
  }

  /** Store the token set plus every derived index used by follow features. */
  private setTokenData(tokens: Token[], source: string): void {
    this.tokens = tokens;
    this.tokenRanges = tokens.length > 0 ? alignTokensToSource(source, tokens) : [];
    this.sentenceRanges =
      tokens.length > 0 ? sentenceRangesByToken(tokens, this.tokenRanges) : [];
    this.sentenceSpans = sentenceTokenSpans(tokens);
    this.previewIndex = null;
    this.previewSearchFrom = 0;
    this.lastPreviewMissLine = null;
  }

  private updateNoteFollow(): void {
    if (
      !this.plugin.settings.followInNote ||
      !this.sourceFile ||
      this.state.total <= 0 ||
      (this.state.status !== "playing" && this.state.status !== "paused")
    ) {
      return;
    }

    const sentenceRange = this.sentenceRanges[this.state.index] ?? null;
    const view = this.sourceMarkdownView();
    if (!view) return;
    const mode = view.getMode();
    if (
      this.lastNoteFollowView === view &&
      this.lastNoteFollowMode === mode &&
      this.sameNoteFollowRange(sentenceRange)
    ) {
      return;
    }

    if (mode === "source") {
      const cm = (view.editor as unknown as { cm?: EditorView }).cm;
      if (!cm) return;
      clearSentenceHighlight(); // the CSS text highlight belongs to preview mode
      this.setPaddedEditor(cm.dom);
      highlightInEditor(
        cm,
        sentenceRange ? { from: sentenceRange.start, to: sentenceRange.end } : null,
      );
      if (sentenceRange) {
        // Obsidian's documented centered scroll (center = true).
        view.editor.scrollIntoView(
          {
            from: view.editor.offsetToPos(sentenceRange.start),
            to: view.editor.offsetToPos(sentenceRange.end),
          },
          true,
        );
      }
      this.rememberNoteFollow(view, mode, sentenceRange);
      return;
    }

    // Reading (preview) view: color the sentence's text with the CSS Custom
    // Highlight API and center it by scrolling the preview scroller directly.
    this.setPaddedEditor(null);
    if (!sentenceRange) return;
    if (this.followSentenceInPreview(view)) {
      this.rememberNoteFollow(view, mode, sentenceRange);
      return;
    }
    // Sentence not found in the rendered DOM (the block may be virtualized and
    // not rendered yet): jump near it by line once, then retry on later ticks.
    const line = (this.sourceText ?? "").slice(0, sentenceRange.start).match(/\n/g)?.length ?? 0;
    if (this.lastPreviewMissLine !== line) {
      this.lastPreviewMissLine = line;
      view.setEphemeralState({ line });
    }
    // The range is deliberately not remembered, so the next word tick retries.
  }

  /**
   * Typewriter padding: give the followed editor room above the first line and
   * below the last so any sentence can scroll to the vertical center. The
   * padding lives on the editor DOM via a class and is removed when following
   * stops or moves to another editor.
   */
  private setPaddedEditor(dom: HTMLElement | null): void {
    if (this.paddedEditorDom === dom) return;
    this.paddedEditorDom?.classList.remove("rsvp-reader-follow-active");
    this.paddedEditorDom = dom;
    this.paddedEditorDom?.classList.add("rsvp-reader-follow-active");
  }

  /**
   * Locate the current sentence's text in the rendered preview, color it, and
   * center it in the preview scroller. Returns false when it cannot (no
   * scroller, or the sentence's block is not rendered yet).
   */
  private followSentenceInPreview(view: MarkdownView): boolean {
    const span = this.sentenceSpans[this.state.index];
    if (!span) return false;
    const words = this.tokens.slice(span.start, span.end + 1).map((t) => t.text);
    if (words.length === 0) return false;

    const container = view.previewMode.containerEl;
    if (!(container instanceof HTMLElement)) return false;
    const scroller = container.matches(".markdown-preview-view")
      ? container
      : (container.querySelector<HTMLElement>(".markdown-preview-view") ?? container);

    // Find the sentence and build a LIVE range; a stale index (the preview
    // re-renders as it scrolls) yields detached nodes, which count as a miss.
    const attempt = (
      idx: PreviewTextIndex,
      from: number,
    ): { span: { start: number; end: number }; range: Range } | null => {
      const span = findSentenceSpan(idx, words, from);
      if (!span) return null;
      const range = rangeForSpan(idx, span);
      if (!range || !range.startContainer.isConnected || !range.endContainer.isConnected) {
        return null;
      }
      return { span, range };
    };

    let index = this.previewIndex;
    let from = this.previewSearchFrom;
    if (!index || index.root !== scroller) {
      index = buildPreviewIndex(scroller);
      from = 0;
    }
    let hit = attempt(index, from);
    if (!hit) {
      index = buildPreviewIndex(scroller);
      hit = attempt(index, 0);
    }
    this.previewIndex = index;
    if (!hit) return false;

    if (!centerRangeInScroller(scroller, hit.range)) {
      // No geometry: the block is not rendered yet. Drop the cache so the next
      // tick rebuilds against the freshly rendered DOM.
      this.previewIndex = null;
      return false;
    }
    applySentenceHighlight(hit.range);
    // Continue the next search after this sentence, so an identical sentence
    // later in the note matches its own occurrence, not this one again.
    this.previewSearchFrom = hit.span.end;
    this.lastPreviewMissLine = null;
    return true;
  }

  private clearNoteFollow(): void {
    const editor = this.sourceEditorView();
    if (editor) highlightInEditor(editor, null);
    clearSentenceHighlight();
    this.setPaddedEditor(null);
    this.previewIndex = null;
    this.previewSearchFrom = 0;
    this.lastPreviewMissLine = null;
    this.lastNoteFollowRange = undefined;
    this.lastNoteFollowView = null;
    this.lastNoteFollowMode = null;
  }

  private rememberNoteFollow(
    view: MarkdownView,
    mode: string,
    range: SourceRange | null,
  ): void {
    this.lastNoteFollowView = view;
    this.lastNoteFollowMode = mode;
    this.lastNoteFollowRange = range ? { start: range.start, end: range.end } : null;
  }

  private sameNoteFollowRange(range: SourceRange | null): boolean {
    if (this.lastNoteFollowRange === undefined) return false;
    if (range === null || this.lastNoteFollowRange === null) {
      return range === this.lastNoteFollowRange;
    }
    return (
      range.start === this.lastNoteFollowRange.start &&
      range.end === this.lastNoteFollowRange.end
    );
  }

  // ---- interaction ----

  private toggleNarration(): void {
    this.plugin.settings.narrate = !this.plugin.settings.narrate;
    void this.plugin.saveSettings();
    this.applyNarration();
  }

  private async toggleFollowInNote(): Promise<void> {
    this.plugin.settings.followInNote = !this.plugin.settings.followInNote;
    const save = this.plugin.saveSettings();
    this.updateFollowButton();
    if (this.plugin.settings.followInNote) {
      await this.ensureNoteOpen();
      this.lastNoteFollowRange = undefined;
      this.updateNoteFollow();
    } else {
      this.clearNoteFollow();
    }
    await save;
    this.root.focus(); // keep keyboard control on the reader
  }

  private setWpm(value: number, persist = true): void {
    const wpm = clampWpm(value);
    this.plugin.settings.wpm = wpm;
    this.wpmInput.value = String(wpm);
    this.wpmValueEl.setText(`${wpm} wpm`);
    this.reader.setTiming(toTimingOptions(this.plugin.settings));
    if (persist) void this.plugin.saveSettings();
  }

  private onKeyDown(e: KeyboardEvent): void {
    switch (e.key) {
      case " ":
        e.preventDefault();
        if (this.state.total > 0) this.reader.toggle();
        break;
      case "ArrowRight":
        e.preventDefault();
        if (e.shiftKey) this.reader.seekBySentence(1);
        else this.reader.seekToIndex(this.state.index + 1);
        break;
      case "ArrowLeft":
        e.preventDefault();
        if (e.shiftKey) this.reader.seekBySentence(-1);
        else this.reader.seekToIndex(this.state.index - 1);
        break;
      case "ArrowUp":
        e.preventDefault();
        this.setWpm(this.plugin.settings.wpm + 10);
        this.applyNarrationSoon(); // held key auto-repeats; coalesce restarts
        break;
      case "ArrowDown":
        e.preventDefault();
        this.setWpm(this.plugin.settings.wpm - 10);
        this.applyNarrationSoon();
        break;
      default:
        break;
    }
  }
}
