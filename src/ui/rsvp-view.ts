import {
  ItemView,
  MarkdownRenderer,
  MarkdownView,
  Menu,
  Notice,
  Platform,
  TFile,
  WorkspaceLeaf,
  setIcon,
} from "obsidian";
import type { EditorView } from "@codemirror/view";
import type RsvpReaderPlugin from "../main";
import { Reader, type ReaderState, type ReaderStatus } from "../reader/reader";
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
import { createCheckpoint, resolveCheckpoint } from "../checkpoints";
import { calculateBookStats, formatBytes, formatDuration } from "../book-stats";
import { toTimingOptions, toTokenizeOptions, toSpeakOptions } from "../settings";
import { highlightInEditor, highlightWordInEditor } from "./note-highlight";
import {
  buildPreviewIndex,
  rangeForSpan,
  findWordSpanInSentence,
  centerRangeInScroller,
  OverlayMarks,
  PreviewFollowState,
  type PreviewHit,
  type PreviewTextIndex,
} from "./preview-follow";

export const VIEW_TYPE_RSVP_READER = "rsvp-reader-view";

const MIN_WPM = 100;
const MAX_WPM = 1000;
const CHECKPOINT_INTERVAL_MS = 10_000;
/** How long the word-level "locate" flash stays lit. */
const LOCATE_FLASH_MS = 3_000;
/** One retry after a preview miss, giving the jumped-to block time to render. */
const LOCATE_RETRY_MS = 350;

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
  private checkpointTimer: number | null = null;
  private restoringCheckpoint = false;
  private appliedNarrationProviderId: string | null = null;
  private paddedEditorDom: HTMLElement | null = null;
  private readonly notePreview = new PreviewFollowState();
  private readonly noteMarks = new OverlayMarks();
  /** The last followed sentence hit in the note's preview (for word marks). */
  private lastNoteHit: PreviewHit | null = null;
  private lastPreviewMissLine: number | null = null;
  private locateFlashTimer: number | null = null;
  private locateRetryTimer: number | null = null;
  private rampTimers: number[] = [];
  private readonly panePreview = new PreviewFollowState();
  /** The pane's current sentence hit, keyed by the sentence's first token. */
  private paneHit: (PreviewHit & { tokenStart: number }) | null = null;
  private paneFlashTimer: number | null = null;
  private readonly paneMarks = new OverlayMarks();
  /** Tap-to-seek data: pane text index, node offsets, and token anchors. */
  private paneClickIndex: PreviewTextIndex | null = null;
  private paneNodeStarts: Map<Text, number> | null = null;
  private paneTokenAnchors: Array<{ textStart: number; token: number }> = [];
  /** Session override for the source pane (button); null = follow the setting. */
  private sourcePaneOverride: boolean | null = null;
  private lastSourcePaneMode: string | null = null;
  private sourcePaneRenderedText: string | null = null;
  private paneRenderSeq = 0;

  private root!: HTMLElement;
  private titleEl!: HTMLElement;
  private statsEl!: HTMLElement;
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
  private locateBtn!: HTMLButtonElement;
  private sourcePaneEl!: HTMLElement;
  private sourcePaneContentEl!: HTMLElement;
  private sourcePaneBtn!: HTMLButtonElement;
  private restartBtn!: HTMLButtonElement;
  private wpmBarEl!: HTMLElement;
  private wpmInput!: HTMLInputElement;
  private wpmValueEl!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, plugin: RsvpReaderPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.reader = new Reader();
    this.reader.setListeners({
      onWord: (_entry, split) => this.renderWord(split),
      onState: (state) => {
        const previousStatus = this.state.status;
        this.renderState(state);
        this.updateCheckpoint(state, previousStatus);
        if (state.status === "paused" && previousStatus === "playing") this.onPaused();
        if (state.status === "playing" && previousStatus !== "playing") this.startRampUp();
        else if (state.status !== "playing" && previousStatus === "playing") this.cancelRampUp();
      },
      onFinish: () => {
        this.root.addClass("is-finished");
        this.clearCurrentCheckpoint();
      },
      // Fires at most once per session start (the reader drops the failed
      // session), so this cannot spam. Cloud narration failures (bad key,
      // network) would otherwise be silent and look like a broken toggle.
      onNarrationError: (err) => new Notice(`RSVP Reader: narration failed. ${err.message}`),
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
    this.persistCheckpointNow();
    this.clearNoteFollow();
    if (this.holdTimer !== null) {
      window.clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
    if (this.narrationApplyTimer !== null) {
      window.clearTimeout(this.narrationApplyTimer);
      this.narrationApplyTimer = null;
    }
    if (this.checkpointTimer !== null) {
      window.clearTimeout(this.checkpointTimer);
      this.checkpointTimer = null;
    }
    if (this.locateFlashTimer !== null) {
      window.clearTimeout(this.locateFlashTimer);
      this.locateFlashTimer = null;
    }
    this.clearLocateRetry();
    this.cancelRampUp();
    this.clearPaneFollow();
    this.reader.destroy();
  }

  /** Load text into the reader and reset to the first word. */
  setContent(text: string, title: string, file: TFile | null = null): void {
    this.persistCheckpointNow();
    this.clearNoteFollow();
    this.title = title;
    this.titleEl.setText(title);
    this.root.removeClass("is-finished");
    this.sourceText = text;
    this.sourceFile = file;
    this.updateFollowButton();
    this.followBtn.toggleClass("rr-hidden", !file);
    this.locateBtn.toggleClass("rr-hidden", !file);
    this.tokenizeKey = JSON.stringify(toTokenizeOptions(this.plugin.settings));
    const tokens = tokenize(text, toTokenizeOptions(this.plugin.settings));
    this.setTokenData(tokens, text);
    this.reader.load(tokens, toTimingOptions(this.plugin.settings));
    this.updateSourcePane();
    this.updateNoteFollow();
    if (tokens.length === 0) {
      this.showEmpty("Nothing readable in this note.");
      return;
    }
    this.restoreCheckpoint();
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
      const previousStatus = this.state.status;
      const anchor = createCheckpoint(
        this.sourceFile?.path ?? "",
        this.tokens,
        this.tokenRanges,
        this.state.index,
      );
      const tokens = tokenize(this.sourceText, toTokenizeOptions(this.plugin.settings));
      this.setTokenData(tokens, this.sourceText);
      const index = anchor ? resolveCheckpoint(anchor, tokens, this.tokenRanges) : 0;
      const restoredStatus =
        previousStatus === "playing" || previousStatus === "paused" ? "paused" : "idle";
      this.restoringCheckpoint = true;
      try {
        this.reader.load(tokens, toTimingOptions(this.plugin.settings), {
          index,
          status: restoredStatus,
        });
        if (previousStatus === "playing" && tokens.length > 0) this.reader.play();
      } finally {
        this.restoringCheckpoint = false;
      }
      if (tokens.length === 0) this.showEmpty("Nothing readable in this note.");
    } else {
      this.reader.setTiming(toTimingOptions(this.plugin.settings));
    }

    // A word-size change alters the natural width, so refit the current word.
    this.fitWord();

    // Provider/enable changes must apply inside the current user gesture so iOS
    // can unlock a fresh audio element. Sliders and same-provider voice changes
    // can fire in bursts, so keep those restarts debounced.
    const nextProviderId = this.plugin.settings.narrate
      ? (this.plugin.getProvider()?.id ?? null)
      : null;
    if (nextProviderId !== this.appliedNarrationProviderId) {
      if (this.narrationApplyTimer !== null) {
        window.clearTimeout(this.narrationApplyTimer);
        this.narrationApplyTimer = null;
      }
      this.applyNarration();
    } else {
      this.applyNarrationSoon();
    }
    this.updateBookStats();
    this.updateSourcePane();
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
      this.reader.setNarration({
        provider,
        speak: toSpeakOptions(this.plugin.settings, provider.id),
      });
      this.appliedNarrationProviderId = provider.id;
      this.narrateBtn.addClass("rr-btn-active");
    } else {
      this.reader.setNarration(null);
      this.appliedNarrationProviderId = null;
      this.narrateBtn.removeClass("rr-btn-active");
    }
    this.narrateBtn.toggleClass("rr-hidden", !provider);
  }

  private updateCheckpoint(state: ReaderState, previousStatus: ReaderStatus): void {
    if (
      this.restoringCheckpoint ||
      !this.plugin.settings.resumeReadingPosition ||
      !this.sourceFile ||
      this.tokens.length === 0
    ) {
      return;
    }
    if (state.status === "paused" && previousStatus === "playing") {
      this.persistCheckpointNow();
      return;
    }
    if (
      (state.status !== "playing" && state.status !== "paused") ||
      this.checkpointTimer !== null
    ) {
      return;
    }
    this.checkpointTimer = window.setTimeout(() => {
      this.checkpointTimer = null;
      this.persistCheckpointNow();
    }, CHECKPOINT_INTERVAL_MS);
  }

  private persistCheckpointNow(): void {
    if (this.checkpointTimer !== null) {
      window.clearTimeout(this.checkpointTimer);
      this.checkpointTimer = null;
    }
    if (
      !this.plugin.settings.resumeReadingPosition ||
      !this.sourceFile ||
      this.tokens.length === 0 ||
      (this.state.status !== "playing" && this.state.status !== "paused")
    ) {
      return;
    }
    const checkpoint = createCheckpoint(
      this.sourceFile.path,
      this.tokens,
      this.tokenRanges,
      this.state.index,
    );
    if (checkpoint) this.plugin.setCheckpoint(checkpoint);
  }

  private restoreCheckpoint(): void {
    const file = this.sourceFile;
    if (!file || !this.plugin.settings.resumeReadingPosition) return;
    const checkpoint = this.plugin.getCheckpoint(file.path);
    if (!checkpoint) return;
    const index = resolveCheckpoint(checkpoint, this.tokens, this.tokenRanges);
    if (index <= 0) return;
    this.restoringCheckpoint = true;
    try {
      this.reader.seekToIndex(index);
    } finally {
      this.restoringCheckpoint = false;
    }
    const stats = calculateBookStats(this.tokens.length, index, this.plugin.settings.wpm);
    new Notice(
      `RSVP Reader: resumed at ${Math.round(stats.progress * 100)}% (${formatDuration(stats.remainingReadingMs)} left).`,
    );
  }

  private clearCurrentCheckpoint(): void {
    if (this.checkpointTimer !== null) {
      window.clearTimeout(this.checkpointTimer);
      this.checkpointTimer = null;
    }
    if (this.sourceFile) this.plugin.clearCheckpoint(this.sourceFile.path);
  }

  private restartReading(): void {
    this.clearCurrentCheckpoint();
    this.reader.stop();
  }

  // ---- DOM ----

  private buildDom(): void {
    this.titleEl = this.root.createDiv({ cls: "rr-title" });
    this.statsEl = this.root.createDiv({ cls: "rr-book-stats" });

    // Embedded source pane: the reader's own split (note text above the
    // stage), for phones where Obsidian cannot split the workspace.
    this.sourcePaneEl = this.root.createDiv({ cls: "rr-source-pane rr-hidden" });
    this.sourcePaneContentEl = this.sourcePaneEl.createDiv({
      cls: "rr-source-content markdown-rendered",
    });
    // Tap a word in the pane to seek the reader there (scrolls do not click).
    this.registerDomEvent(this.sourcePaneEl, "click", (e) => this.onPaneClick(e));

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

    // The overlay marks hold absolute positions, so a pane resize (which
    // reflows the text) must trigger a redraw at the new geometry.
    const paneResizeObserver = new ResizeObserver(() => this.updatePaneFollow(true));
    paneResizeObserver.observe(this.sourcePaneEl);
    this.register(() => paneResizeObserver.disconnect());

    const progress = this.root.createDiv({ cls: "rr-progress" });
    this.progressFillEl = progress.createDiv({ cls: "rr-progress-fill" });
    this.progressKnobEl = progress.createDiv({ cls: "rr-progress-knob" });
    this.setupScrub(progress);

    // On phones the row would hold eight buttons, so the four low-frequency
    // actions (rr-btn-secondary) collapse behind a "More" menu there; the
    // high-frequency transport (prev / play / next / locate) stays one tap.
    // Desktop keeps every button and hides "More" (see styles.css).
    const controls = this.root.createDiv({ cls: "rr-controls" });
    this.restartBtn = this.makeButton(controls, "rotate-ccw", "Restart", () =>
      this.restartReading(),
    );
    this.restartBtn.addClass("rr-btn-secondary");
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
    this.narrateBtn.addClass("rr-btn-secondary");
    this.followBtn = this.makeButton(controls, "file-text", "Follow in note", () =>
      void this.toggleFollowInNote(),
    );
    this.updateFollowButton();
    this.followBtn.addClass("rr-hidden");
    this.followBtn.addClass("rr-btn-secondary");
    this.locateBtn = this.makeButton(controls, "locate", "Show my place in the note", () =>
      void this.locateInNote(),
    );
    this.locateBtn.addClass("rr-hidden");
    this.sourcePaneBtn = this.makeButton(controls, "book-open", "Show the note inside the reader", () =>
      this.toggleSourcePane(),
    );
    this.sourcePaneBtn.addClass("rr-hidden");
    this.sourcePaneBtn.addClass("rr-btn-secondary");
    const moreBtn = this.makeButton(controls, "ellipsis-vertical", "More", () =>
      this.showMoreMenu(moreBtn),
    );
    moreBtn.addClass("rr-more");
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

  /** The collapsed secondary actions, for phones (see rr-btn-secondary). */
  private showMoreMenu(anchor: HTMLElement): void {
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle("Restart")
        .setIcon("rotate-ccw")
        .onClick(() => this.restartReading()),
    );
    if (this.plugin.getProvider()) {
      menu.addItem((item) =>
        item
          .setTitle("Narrate while reading")
          .setIcon("volume-2")
          .setChecked(this.plugin.settings.narrate)
          .onClick(() => this.toggleNarration()),
      );
    }
    // On a phone with the pane open, following the (hidden) note tab is
    // meaningless; offering it would only confuse. The pane follows already.
    if (this.sourceFile && !(Platform.isPhone && this.sourcePaneVisible())) {
      menu.addItem((item) =>
        item
          .setTitle("Follow in note")
          .setIcon("file-text")
          .setChecked(this.plugin.settings.followInNote)
          .onClick(() => void this.toggleFollowInNote()),
      );
    }
    if (this.sourceText !== null && this.tokens.length > 0) {
      menu.addItem((item) =>
        item
          .setTitle("Show the note in the reader")
          .setIcon("book-open")
          .setChecked(this.sourcePaneEnabled())
          .onClick(() => this.toggleSourcePane()),
      );
    }
    const rect = anchor.getBoundingClientRect();
    menu.showAtPosition({ x: rect.left, y: rect.top });
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
   * Word-area gestures: tap toggles play/pause; press and hold reads while
   * held and pauses on release ("hold to read, release to see where you
   * are"); a horizontal swipe jumps a sentence back or forward (swipe left =
   * next, like flipping a page onward). The word, counter, and progress mark
   * your position.
   */
  private setupStageGesture(stage: HTMLElement): void {
    const HOLD_MS = 220;
    const SWIPE_PX = 48;
    let activePointer: number | null = null;
    let holding = false;
    let holdStartedPlayback = false;
    let startX = 0;
    let startY = 0;
    let swipeDir: -1 | 0 | 1 = 0;

    const end = (commitTap: boolean): void => {
      if (this.holdTimer !== null) {
        // Released before the hold threshold: treat as a tap (toggle).
        window.clearTimeout(this.holdTimer);
        this.holdTimer = null;
        if (commitTap && this.state.total > 0) this.reader.toggle();
      } else if (swipeDir !== 0) {
        if (commitTap && this.state.total > 0) this.reader.seekBySentence(swipeDir);
      } else if (holding && holdStartedPlayback) {
        // The hold started playback, so releasing pauses where it landed. A
        // hold that began while already playing leaves playback untouched.
        this.reader.pause();
      }
      holding = false;
      holdStartedPlayback = false;
      swipeDir = 0;
      activePointer = null;
      this.root.focus();
    };

    this.registerDomEvent(stage, "pointerdown", (e) => {
      if (activePointer !== null || this.state.total <= 0) return;
      activePointer = e.pointerId;
      holding = false;
      holdStartedPlayback = false;
      swipeDir = 0;
      startX = e.clientX;
      startY = e.clientY;
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
    this.registerDomEvent(stage, "pointermove", (e) => {
      if (e.pointerId !== activePointer || holding || swipeDir !== 0) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (Math.abs(dx) >= SWIPE_PX && Math.abs(dx) > 2 * Math.abs(dy)) {
        swipeDir = dx < 0 ? 1 : -1;
        // A decisive swipe is not a tap and not a hold.
        if (this.holdTimer !== null) {
          window.clearTimeout(this.holdTimer);
          this.holdTimer = null;
        }
      }
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
    if (state.status === "idle" && previousStatus !== "idle") {
      this.clearNoteFollow();
      this.clearPaneFollow();
    }
    this.updateBookStats();
    this.updateNoteFollow();
    this.updatePaneFollow();
  }

  private updateBookStats(): void {
    const stats = calculateBookStats(
      this.state.total,
      this.state.index,
      this.plugin.settings.wpm,
    );
    if (stats.totalWords === 0) {
      this.statsEl.setText("");
      return;
    }
    const parts = [
      `${stats.totalWords.toLocaleString()} words`,
      `${Math.round(stats.progress * 100)}%`,
      `${formatDuration(stats.remainingReadingMs)} left at ${this.plugin.settings.wpm} WPM`,
    ];
    if (this.plugin.settings.ttsProvider === "unreal-speech") {
      parts.push(`~${formatBytes(stats.estimatedNarrationBytes)} audio`);
    }
    this.statsEl.setText(parts.join(" · "));
  }

  private showEmpty(message: string): void {
    this.statsEl.setText("");
    this.wordEl.addClass("rr-hidden");
    this.emptyEl.removeClass("rr-hidden");
    this.emptyEl.setText(message);
    this.counterEl.setText("0 / 0");
    this.progressFillEl.setCssStyles({ width: "0%" });
    this.progressKnobEl.setCssStyles({ left: "0%" });
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
    this.notePreview.reset();
    this.lastPreviewMissLine = null;
    // A re-tokenize over the same text (content settings) keeps the rendered
    // pane, but the token indices moved, so the tap-to-seek map must follow.
    if (this.sourcePaneRenderedText === source && this.paneClickIndex) {
      this.buildPaneClickMap();
    }
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
      // Same sentence: only the word marker moves (preview mode).
      if (mode === "preview" && this.lastNoteHit) {
        this.noteMarks.moveWord(
          this.currentWordRangeInPreview(this.lastNoteHit),
          this.plugin.settings.paneMarkerStyle,
        );
      }
      return;
    }

    if (mode === "source") {
      const cm = (view.editor as unknown as { cm?: EditorView }).cm;
      if (!cm) return;
      this.clearNoteMarks(); // the overlay marks belong to preview mode
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

    // Reading (preview) view: color the sentence's text with overlay marks
    // and center it by scrolling the preview scroller directly.
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
    const scroller = this.previewScroller(view);
    if (!scroller) return false;
    const hit = this.notePreview.find(scroller, this.currentSentenceWords());
    if (!hit) return false;

    if (!centerRangeInScroller(scroller, hit.range)) {
      // No geometry: the block is not rendered yet. Drop the cache so the next
      // tick rebuilds against the freshly rendered DOM.
      this.notePreview.invalidate();
      return false;
    }
    this.noteMarks.drawSentence(this.previewSizer(scroller), hit.range);
    this.noteMarks.moveWord(
      this.currentWordRangeInPreview(hit),
      this.plugin.settings.paneMarkerStyle,
    );
    this.lastNoteHit = hit;
    // Continue the next search after this sentence, so an identical sentence
    // later in the note matches its own occurrence, not this one again.
    this.notePreview.searchFrom = hit.span.end;
    this.notePreview.lastSpan = hit.span;
    this.lastPreviewMissLine = null;
    return true;
  }

  private previewScroller(view: MarkdownView): HTMLElement | null {
    const container = view.previewMode.containerEl;
    if (!container.instanceOf(HTMLElement)) return null;
    return container.matches(".markdown-preview-view")
      ? container
      : (container.querySelector<HTMLElement>(".markdown-preview-view") ?? container);
  }

  /** The preview's content element (scrolls with the text; hosts the marks). */
  private previewSizer(scroller: HTMLElement): HTMLElement {
    return scroller.querySelector<HTMLElement>(".markdown-preview-sizer") ?? scroller;
  }

  /** Display words of the sentence containing the current token. */
  private currentSentenceWords(): string[] {
    const span = this.sentenceSpans[this.state.index];
    if (!span) return [];
    return this.tokens.slice(span.start, span.end + 1).map((t) => t.text);
  }

  private clearNoteMarks(): void {
    this.noteMarks.clear();
    this.lastNoteHit = null;
  }

  private clearNoteFollow(): void {
    const editor = this.sourceEditorView();
    if (editor) {
      highlightInEditor(editor, null);
      highlightWordInEditor(editor, null);
    }
    this.clearNoteMarks();
    this.setPaddedEditor(null);
    this.notePreview.reset();
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

  /**
   * Pause auto-locate: flash the current word in the note that is already
   * open, without opening or revealing anything (unlike the Locate button).
   * On a phone the note tab is hidden behind the reader; the flash still
   * positions and marks it, so switching to it lands on the right spot.
   */
  private onPaused(): void {
    if (
      !this.plugin.settings.locateOnPause ||
      this.restoringCheckpoint ||
      this.state.total <= 0
    ) {
      return;
    }
    if (this.flashInPane()) return;
    if (!this.sourceFile) return;
    const view = this.sourceMarkdownView();
    if (view) this.flashCurrentWord(view, false);
  }

  /**
   * One-tap "where am I": open/reveal the source note, scroll it to the current
   * word, and flash that word for a few seconds. On phones, where Obsidian has
   * no split panes, revealing switches to the note's tab, which is exactly the
   * "jump back to my place" flow.
   */
  private async locateInNote(): Promise<void> {
    if (this.state.total <= 0) return;
    // With the embedded pane open, "where am I" is answered right here; do not
    // switch away from the reader (on phones revealing would swap tabs).
    if (this.flashInPane()) return;
    if (!this.sourceFile) return;
    await this.ensureNoteOpen();
    const view = this.sourceMarkdownView();
    if (!view) return;
    await this.app.workspace.revealLeaf(view.leaf);
    this.flashCurrentWord(view, true);
  }

  /**
   * Highlight the current word (strong) and its sentence (soft) in the note
   * and scroll them into view. The word mark clears after LOCATE_FLASH_MS; the
   * sentence stays only while "Follow in note" owns it.
   */
  private flashCurrentWord(view: MarkdownView, retryOnMiss: boolean): void {
    if (this.state.total <= 0) return;
    this.clearLocateRetry();
    const wordRange = this.tokenRanges[this.state.index] ?? null;
    const sentenceRange = this.sentenceRanges[this.state.index] ?? null;

    if (view.getMode() === "source") {
      const cm = (view.editor as unknown as { cm?: EditorView }).cm;
      if (!cm) return;
      highlightInEditor(
        cm,
        sentenceRange ? { from: sentenceRange.start, to: sentenceRange.end } : null,
      );
      highlightWordInEditor(
        cm,
        wordRange ? { from: wordRange.start, to: wordRange.end } : null,
      );
      const target = wordRange ?? sentenceRange;
      if (target) {
        view.editor.scrollIntoView(
          { from: view.editor.offsetToPos(target.start), to: view.editor.offsetToPos(target.end) },
          true,
        );
      }
      this.scheduleFlashClear();
      return;
    }

    const scroller = this.previewScroller(view);
    if (!scroller) return;
    const hit = this.notePreview.refind(scroller, this.currentSentenceWords());
    if (!hit) {
      // The sentence's block is not rendered (virtualized): jump near it by
      // line, give it a beat to render, then retry once.
      if (sentenceRange) {
        const line =
          (this.sourceText ?? "").slice(0, sentenceRange.start).match(/\n/g)?.length ?? 0;
        view.setEphemeralState({ line });
      }
      if (retryOnMiss) {
        this.locateRetryTimer = window.setTimeout(() => {
          this.locateRetryTimer = null;
          this.flashCurrentWord(view, false);
        }, LOCATE_RETRY_MS);
      }
      return;
    }
    const wordDomRange = this.currentWordRangeInPreview(hit);
    this.noteMarks.drawSentence(this.previewSizer(scroller), hit.range);
    this.noteMarks.moveWord(wordDomRange, this.plugin.settings.paneMarkerStyle);
    this.noteMarks.setFlash(true);
    this.lastNoteHit = hit;
    centerRangeInScroller(scroller, wordDomRange ?? hit.range);
    this.scheduleFlashClear();
  }

  /** DOM range of the current word inside a found sentence, or null. */
  private currentWordRangeInPreview(hit: PreviewHit): Range | null {
    const span = this.sentenceSpans[this.state.index];
    if (!span) return null;
    const wordSpan = findWordSpanInSentence(
      hit.index,
      hit.span,
      this.currentSentenceWords(),
      this.state.index - span.start,
    );
    return wordSpan ? rangeForSpan(hit.index, wordSpan) : null;
  }

  private scheduleFlashClear(): void {
    if (this.locateFlashTimer !== null) window.clearTimeout(this.locateFlashTimer);
    this.locateFlashTimer = window.setTimeout(() => {
      this.locateFlashTimer = null;
      this.clearWordFlash();
    }, LOCATE_FLASH_MS);
  }

  /** Drop the word flash; keep the sentence lit only if follow still owns it. */
  private clearWordFlash(): void {
    const cm = this.sourceEditorView();
    if (cm) highlightWordInEditor(cm, null);
    this.noteMarks.setFlash(false);
    const active = this.state.status === "playing" || this.state.status === "paused";
    // While follow owns the marks they stay (sentence and word both show the
    // standing position); otherwise the flash was all there was, so clear.
    if (!this.plugin.settings.followInNote || !active) {
      if (cm) highlightInEditor(cm, null);
      this.clearNoteMarks();
    }
  }

  private clearLocateRetry(): void {
    if (this.locateRetryTimer !== null) {
      window.clearTimeout(this.locateRetryTimer);
      this.locateRetryTimer = null;
    }
  }

  // ---- embedded source pane ----

  private sourcePaneEnabled(): boolean {
    if (this.sourcePaneOverride !== null) return this.sourcePaneOverride;
    const mode = this.plugin.settings.sourcePaneMode;
    return mode === "always" || (mode === "auto" && Platform.isPhone);
  }

  private toggleSourcePane(): void {
    this.sourcePaneOverride = !this.sourcePaneEnabled();
    this.updateSourcePane();
  }

  private sourcePaneVisible(): boolean {
    return !this.sourcePaneEl.hasClass("rr-hidden");
  }

  /** Show/hide the pane per setting + session override, rendering on demand. */
  private updateSourcePane(): void {
    // A changed setting takes effect even after the button was used this session.
    if (this.plugin.settings.sourcePaneMode !== this.lastSourcePaneMode) {
      this.lastSourcePaneMode = this.plugin.settings.sourcePaneMode;
      this.sourcePaneOverride = null;
    }
    const hasContent = this.sourceText !== null && this.tokens.length > 0;
    this.sourcePaneBtn.toggleClass("rr-hidden", !hasContent);
    const visible = hasContent && this.sourcePaneEnabled();
    this.sourcePaneBtn.toggleClass("rr-btn-active", visible);
    this.root.toggleClass("rr-has-source-pane", visible);
    this.sourcePaneEl.toggleClass("rr-hidden", !visible);
    if (!visible) {
      this.clearPaneFollow();
      return;
    }
    if (this.sourcePaneRenderedText !== this.sourceText) void this.renderSourcePane();
    else this.updatePaneFollow(true);
  }

  private async renderSourcePane(): Promise<void> {
    const text = this.sourceText;
    const seq = ++this.paneRenderSeq;
    this.panePreview.reset();
    this.clearPaneFollow();
    this.sourcePaneRenderedText = text;
    // Render into a detached element so a superseding setContent() can never
    // interleave two notes' blocks in the live pane.
    const target = document.createElement("div");
    try {
      await MarkdownRenderer.render(
        this.app,
        text ?? "",
        target,
        this.sourceFile?.path ?? "",
        this,
      );
    } catch {
      if (seq === this.paneRenderSeq) this.sourcePaneRenderedText = null;
      return;
    }
    if (seq !== this.paneRenderSeq) return;
    this.sourcePaneContentEl.empty();
    while (target.firstChild) this.sourcePaneContentEl.appendChild(target.firstChild);
    this.buildPaneClickMap();
    this.updatePaneFollow(true);
  }

  // ---- tap-to-seek ----

  /**
   * Align every token to the pane's rendered text once per render, so a tap
   * can resolve its character offset to the nearest token in O(log n).
   */
  private buildPaneClickMap(): void {
    const index = buildPreviewIndex(this.sourcePaneContentEl);
    this.paneClickIndex = index;
    this.paneNodeStarts = new Map(index.nodes.map((node, i) => [node, index.starts[i]]));
    const ranges = alignTokensToSource(index.text, this.tokens);
    this.paneTokenAnchors = [];
    ranges.forEach((range, token) => {
      if (range) this.paneTokenAnchors.push({ textStart: range.start, token });
    });
  }

  /** Character offset in the pane text under the pointer, or null. */
  private paneCaretOffset(x: number, y: number): number | null {
    // caretRangeFromPoint hit-tests the overlay marks even though they are
    // pointer-events: none, so blank the layer for the synchronous lookup.
    return this.paneMarks.withHidden(() => this.paneCaretOffsetUnobstructed(x, y));
  }

  private paneCaretOffsetUnobstructed(x: number, y: number): number | null {
    const doc = this.sourcePaneContentEl.ownerDocument as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
      caretPositionFromPoint?: (
        x: number,
        y: number,
      ) => { offsetNode: Node; offset: number } | null;
    };
    let node: Node | null = null;
    let offset = 0;
    if (typeof doc.caretRangeFromPoint === "function") {
      const range = doc.caretRangeFromPoint(x, y);
      if (range) {
        node = range.startContainer;
        offset = range.startOffset;
      }
    } else if (typeof doc.caretPositionFromPoint === "function") {
      const position = doc.caretPositionFromPoint(x, y);
      if (position) {
        node = position.offsetNode;
        offset = position.offset;
      }
    }
    if (!node || node.nodeType !== Node.TEXT_NODE) return null;
    const start = this.paneNodeStarts?.get(node as Text);
    return start === undefined ? null : start + offset;
  }

  private tokenAtPaneOffset(offset: number): number | null {
    const anchors = this.paneTokenAnchors;
    if (anchors.length === 0) return null;
    let lo = 0;
    let hi = anchors.length - 1;
    let ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (anchors[mid].textStart <= offset) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return anchors[ans].token;
  }

  private onPaneClick(e: MouseEvent): void {
    if (this.state.total <= 0 || !this.paneClickIndex) return;
    // A click at the end of a drag-selection must not throw the position away.
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return;
    // The pane is a reading surface, not a browser: swallow link navigation
    // and treat the tap as a seek like anywhere else.
    if ((e.target as HTMLElement | null)?.closest?.("a")) e.preventDefault();
    const offset = this.paneCaretOffset(e.clientX, e.clientY);
    if (offset === null) return;
    const token = this.tokenAtPaneOffset(offset);
    if (token === null) return;
    this.reader.seekToIndex(token);
  }

  /**
   * Follow inside the pane; always on while it is visible. The sentence is
   * re-found and centered only when it changes; the word marker updates on
   * every tick. Marks are the reader's own overlay boxes (the pane DOM is
   * ours), so they render on every engine, including iOS versions without the
   * CSS Custom Highlight API.
   */
  private updatePaneFollow(force = false): void {
    if (!this.sourcePaneVisible() || this.state.total <= 0) return;
    if (this.state.status !== "playing" && this.state.status !== "paused") return;
    const span = this.sentenceSpans[this.state.index];
    if (!span) return;

    const sameSentence =
      !force &&
      this.paneHit !== null &&
      this.paneHit.tokenStart === span.start &&
      this.paneHit.range.startContainer.isConnected;
    if (!sameSentence) {
      const found = this.panePreview.find(this.sourcePaneEl, this.currentSentenceWords());
      if (!found) return;
      if (!centerRangeInScroller(this.sourcePaneEl, found.range)) {
        this.panePreview.invalidate();
        return;
      }
      this.panePreview.searchFrom = found.span.end;
      this.panePreview.lastSpan = found.span;
      this.paneHit = { ...found, tokenStart: span.start };
      this.paneMarks.drawSentence(this.sourcePaneContentEl, this.paneHit.range);
    }
    this.paneMarks.moveWord(
      this.currentWordRangeInPreview(this.paneHit!),
      this.plugin.settings.paneMarkerStyle,
    );
  }

  /**
   * Locate within the pane: re-center on the current word and pulse its
   * marker. Returns false when the pane cannot show the position.
   */
  private flashInPane(): boolean {
    if (!this.sourcePaneVisible() || this.state.total <= 0) return false;
    this.updatePaneFollow(true);
    if (!this.paneHit) return false;
    const wordDomRange = this.currentWordRangeInPreview(this.paneHit);
    if (wordDomRange) centerRangeInScroller(this.sourcePaneEl, wordDomRange);
    this.paneMarks.setFlash(true);
    if (this.paneFlashTimer !== null) window.clearTimeout(this.paneFlashTimer);
    this.paneFlashTimer = window.setTimeout(() => {
      this.paneFlashTimer = null;
      this.paneMarks.setFlash(false);
    }, LOCATE_FLASH_MS);
    return true;
  }

  private clearPaneFollow(): void {
    if (this.paneFlashTimer !== null) {
      window.clearTimeout(this.paneFlashTimer);
      this.paneFlashTimer = null;
    }
    this.paneMarks.clear();
    this.paneHit = null;
  }

  /**
   * Ease back into pace after every (re)start: ~70% for the first beat, then
   * 85%, then full speed within a second. Re-entering the word stream cold at
   * full WPM costs a few missed words; the ramp absorbs that. Narrated runs
   * skip it, since audio owns the pace and would desync from a slowed visual.
   */
  private startRampUp(): void {
    this.cancelRampUp();
    if (!this.plugin.settings.rampUpOnPlay) return;
    if (this.plugin.settings.narrate && this.plugin.getProvider()) return;
    const apply = (factor: number): void => {
      const timing = toTimingOptions(this.plugin.settings);
      this.reader.setTiming({
        ...timing,
        wpm: Math.max(MIN_WPM, Math.round(timing.wpm * factor)),
      });
    };
    apply(0.7);
    this.rampTimers.push(window.setTimeout(() => apply(0.85), 450));
    this.rampTimers.push(
      window.setTimeout(() => {
        this.rampTimers = [];
        apply(1);
      }, 900),
    );
  }

  private cancelRampUp(): void {
    for (const timer of this.rampTimers) window.clearTimeout(timer);
    this.rampTimers = [];
  }

  private setWpm(value: number, persist = true): void {
    this.cancelRampUp(); // a manual speed change wins over a pending ramp step
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
