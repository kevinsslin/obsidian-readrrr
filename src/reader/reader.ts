import { splitOrp, type OrpSplit } from "../core/orp";
import {
  buildTimeline,
  indexAtMs,
  type TimingOptions,
} from "../core/scheduler";
import type { Token, TimelineEntry } from "../core/types";
import type { TtsProvider, TtsSession, SpeakOptions } from "../tts/types";
import { systemClock, type Clock } from "./clock";

export type ReaderStatus = "idle" | "playing" | "paused" | "finished";

export interface ReaderState {
  status: ReaderStatus;
  index: number;
  total: number;
}

export interface ReaderListeners {
  /** Render this word (with its ORP split) now. */
  onWord?(entry: TimelineEntry, split: OrpSplit): void;
  /** Playback state changed. */
  onState?(state: ReaderState): void;
  /** Reached the end. */
  onFinish?(): void;
}

export interface NarrationConfig {
  provider: TtsProvider;
  speak: SpeakOptions;
}

/**
 * Drives the RSVP display. It always advances the visual word from an estimated
 * timeline using its clock; when narration is enabled it also starts a TTS
 * session and snaps the display to the provider's word/sentence events so audio
 * stays the master clock. DOM-free: it emits words through `onWord` and lets
 * the view render them.
 */
export class Reader {
  private readonly clock: Clock;
  private tokens: Token[] = [];
  private timeline: TimelineEntry[] = [];
  private status: ReaderStatus = "idle";
  private currentIndex = 0;
  /** Elapsed ms captured at the last play/seek/pause. */
  private baseElapsed = 0;
  /** clock.now() at the start of the current playing segment. */
  private segmentStart = 0;
  private timer: number | null = null;
  private listeners: ReaderListeners = {};
  private narration: NarrationConfig | null = null;
  private session: TtsSession | null = null;
  /** Identifies the current play run; guards the tick loop against reentrancy. */
  private runEpoch = 0;
  /** Identifies the current TTS session; invalidates stale session callbacks. */
  private sessionSeq = 0;
  /** True while the estimate waits at a sentence boundary for the audio. */
  private parked = false;
  /** Pending coalesced narration restart (after a burst of seeks). */
  private restartTimer: number | null = null;

  constructor(clock: Clock = systemClock) {
    this.clock = clock;
  }

  setListeners(listeners: ReaderListeners): void {
    this.listeners = listeners;
  }

  /** Load new content, reset to the first word, and stay idle. */
  load(tokens: Token[], timing: TimingOptions): void {
    this.stopInternal();
    this.tokens = tokens;
    this.timeline = buildTimeline(tokens, timing);
    this.status = "idle";
    this.currentIndex = 0;
    this.baseElapsed = 0;
    if (this.timeline.length > 0) this.renderIndex(0);
    this.emitState();
  }

  /**
   * Rebuild the timeline for new timing (e.g. a WPM change) while keeping the
   * current word. The TTS rate updates on the next (re)start, not mid-utterance.
   */
  setTiming(timing: TimingOptions): void {
    if (this.tokens.length === 0) {
      this.timeline = [];
      return;
    }
    const idx = Math.min(Math.max(0, this.currentIndex), this.tokens.length - 1);
    this.timeline = buildTimeline(this.tokens, timing);
    this.currentIndex = idx;
    if (this.parked) {
      // Still waiting for the audio at a sentence boundary: stay parked, with
      // the frozen estimate re-anchored to the boundary under the new timing.
      const entry = this.timeline[idx];
      this.baseElapsed = entry.startMs + entry.durationMs;
      this.segmentStart = this.clock.now();
      return;
    }
    this.baseElapsed = this.timeline[idx].startMs;
    if (this.status === "playing") {
      this.segmentStart = this.clock.now();
      this.runEpoch++;
      this.clearTimer();
      this.scheduleTick();
    }
  }

  /** Enable or disable narration; applies immediately if playing. */
  setNarration(config: NarrationConfig | null): void {
    const prev = this.narration;
    this.narration = config;
    if (this.status !== "playing") return;

    // Restart the audio only when something audible actually changed. Spurious
    // restarts are not just wasteful: rapid speechSynthesis cancel/speak cycles
    // can destabilize the OS audio daemon (macOS Core Audio crackling).
    const unchanged =
      !!config &&
      !!prev &&
      this.session !== null &&
      prev.provider === config.provider &&
      prev.speak.voiceId === config.speak.voiceId &&
      prev.speak.rate === config.speak.rate &&
      prev.speak.pitch === config.speak.pitch &&
      prev.speak.volume === config.speak.volume &&
      prev.speak.maxTokensPerChunk === config.speak.maxTokensPerChunk;
    if (unchanged) return;
    if (!config && !prev && !this.session) return;

    this.stopSession();
    this.startSession();
    // The loop may have been parked at a sentence boundary waiting for the
    // old audio; re-anchor at the current word and restart the ticks.
    this.resumeEstimatedFrom(this.currentIndex);
  }

  getState(): ReaderState {
    return { status: this.status, index: this.currentIndex, total: this.timeline.length };
  }

  play(): void {
    if (this.timeline.length === 0) return;
    if (this.status === "finished" || this.currentIndex >= this.timeline.length) {
      this.currentIndex = 0;
      this.baseElapsed = 0;
      this.renderIndex(0);
    }
    if (this.status === "playing") return;
    this.status = "playing";
    this.runEpoch++;
    this.segmentStart = this.clock.now();
    this.startSession();
    this.scheduleTick();
    this.emitState();
  }

  pause(): void {
    if (this.status !== "playing") return;
    this.baseElapsed = this.currentElapsed();
    this.parked = false;
    this.status = "paused";
    this.runEpoch++;
    this.clearTimer();
    this.clearRestartTimer();
    this.stopSession();
    this.emitState();
  }

  toggle(): void {
    if (this.status === "playing") this.pause();
    else this.play();
  }

  /** Stop and reset to the first word. */
  stop(): void {
    this.stopInternal();
    if (this.timeline.length > 0) this.renderIndex(0);
    this.emitState();
  }

  seekToIndex(index: number): void {
    if (this.timeline.length === 0) return;
    const idx = Math.min(Math.max(0, index), this.timeline.length - 1);
    this.runEpoch++;
    this.parked = false;
    this.baseElapsed = this.timeline[idx].startMs;
    this.renderIndex(idx);
    if (this.status === "playing") {
      this.segmentStart = this.clock.now();
      // Stop the audio at once, but coalesce the restart: a burst of seeks
      // (held arrow key, scrubbing) becomes one speech restart instead of a
      // cancel/speak storm against the OS audio daemon.
      this.stopSession();
      this.scheduleSessionRestart();
      this.clearTimer();
      this.scheduleTick();
    } else if (this.status === "finished") {
      this.status = "paused";
    }
    this.emitState();
  }

  /** Jump to the start of the previous (-1) or next (1) sentence. */
  seekBySentence(direction: -1 | 1): void {
    this.seekToIndex(this.findSentenceStart(this.currentIndex, direction));
  }

  destroy(): void {
    this.stopInternal();
    this.listeners = {};
  }

  // ---- internals ----

  private currentElapsed(): number {
    if (this.status === "playing") {
      // While parked the estimate is frozen at the boundary, so wall time does
      // not inflate the position while we wait for the audio.
      if (this.parked) return this.baseElapsed;
      return this.baseElapsed + (this.clock.now() - this.segmentStart);
    }
    return this.baseElapsed;
  }

  /** Re-anchor the estimated clock at `index` and restart the tick loop. */
  private resumeEstimatedFrom(index: number): void {
    this.parked = false;
    const entry = this.timeline[Math.max(0, Math.min(index, this.timeline.length - 1))];
    this.baseElapsed = entry ? entry.startMs : 0;
    this.segmentStart = this.clock.now();
    this.clearTimer();
    this.scheduleTick();
  }

  private scheduleTick(): void {
    if (this.status !== "playing") return;
    // Defensive: never allow two live timers (e.g. a synchronous provider
    // error scheduling a resume while play() is still mid-flight).
    this.clearTimer();
    const epoch = this.runEpoch;
    const elapsed = this.currentElapsed();
    const idx = indexAtMs(this.timeline, elapsed);

    // With narration active, audio is the master clock: the estimated clock may
    // pace words WITHIN the sentence being spoken, but must never run past its
    // end. Park at the boundary and wait for the provider's word/sentence-end
    // events (or onEnd) to move on; only audio may finish the run.
    if (this.session) {
      const cap = this.sentenceCapFrom(this.currentIndex);
      if (idx > cap) {
        const capEntry = this.timeline[cap];
        this.baseElapsed = capEntry.startMs + capEntry.durationMs;
        this.segmentStart = this.clock.now();
        this.parked = true;
        if (cap !== this.currentIndex) this.renderIndex(cap);
        return; // parked; provider events restart the loop via snapTo/finish
      }
    }
    this.parked = false;

    if (idx >= this.timeline.length) {
      this.finish();
      return;
    }
    if (idx !== this.currentIndex) this.renderIndex(idx);
    // A reentrant listener (via onWord) may have changed the run; if so, let
    // its scheduling win rather than adding a second, stale timer.
    if (epoch !== this.runEpoch || this.status !== "playing") return;
    const entry = this.timeline[idx];
    const msUntilNext = Math.max(1, entry.startMs + entry.durationMs - elapsed);
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      this.scheduleTick();
    }, msUntilNext);
  }

  private startSession(): void {
    if (!this.narration) return;
    const startIndex = this.currentIndex;
    const slice = this.tokens.slice(startIndex);
    // Tag this session; ignore events from a session that was later stopped or
    // superseded (even synchronously, from inside speak()).
    const seq = ++this.sessionSeq;
    const isCurrent = () => seq === this.sessionSeq;
    const session = this.narration.provider.speak(slice, this.narration.speak, {
      onWordSpoken: (rel) => {
        if (isCurrent()) this.snapTo(startIndex + rel);
      },
      onSentenceEnd: (rel) => {
        if (isCurrent()) this.snapTo(startIndex + rel);
      },
      onEnd: () => {
        if (isCurrent()) this.finish();
      },
      onError: () => {
        if (!isCurrent()) return;
        // Audio failed: drop the session (so the sentence cap no longer
        // applies) and let the estimated clock carry the run silently.
        this.sessionSeq++;
        const failed = this.session;
        this.session = null;
        failed?.stop();
        if (this.status === "playing") {
          this.clearTimer();
          this.scheduleTick();
        }
      },
    });
    if (!isCurrent()) {
      // A callback finished or superseded the run synchronously during speak().
      session.stop();
      return;
    }
    this.session = session;
  }

  private stopSession(): void {
    // Bump the sequence first so any in-flight callbacks are ignored.
    this.sessionSeq++;
    if (this.session) {
      this.session.stop();
      this.session = null;
    }
  }

  /** Start narration again after a short quiet period (coalesces seek bursts). */
  private scheduleSessionRestart(delayMs = 200): void {
    if (!this.narration) return;
    this.clearRestartTimer();
    this.restartTimer = this.clock.setTimeout(() => {
      this.restartTimer = null;
      if (this.status === "playing" && !this.session) this.startSession();
    }, delayMs);
  }

  private clearRestartTimer(): void {
    if (this.restartTimer !== null) {
      this.clock.clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  /** Snap the display to a token reported by the TTS provider. */
  private snapTo(index: number): void {
    if (this.status !== "playing") return;
    if (index < 0 || index >= this.timeline.length) return;
    this.parked = false;
    this.baseElapsed = this.timeline[index].startMs;
    this.segmentStart = this.clock.now();
    if (index !== this.currentIndex) this.renderIndex(index);
    this.clearTimer();
    this.scheduleTick();
  }

  private finish(): void {
    this.clearTimer();
    this.stopSession();
    this.status = "finished";
    this.runEpoch++;
    const epoch = this.runEpoch;
    if (this.timeline.length > 0) this.renderIndex(this.timeline.length - 1);
    // A listener may have restarted or stopped us during renderIndex.
    if (epoch !== this.runEpoch) return;
    this.emitState();
    this.listeners.onFinish?.();
  }

  private stopInternal(): void {
    this.status = "idle";
    this.currentIndex = 0;
    this.baseElapsed = 0;
    this.parked = false;
    this.runEpoch++;
    this.clearTimer();
    this.clearRestartTimer();
    this.stopSession();
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      this.clock.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private renderIndex(index: number): void {
    const previousIndex = this.currentIndex;
    this.currentIndex = index;
    const entry = this.timeline[index];
    if (!entry) return;
    this.listeners.onWord?.(entry, splitOrp(entry.token.text));
    if (index !== previousIndex && this.currentIndex === index) this.emitState();
  }

  private emitState(): void {
    this.listeners.onState?.(this.getState());
  }

  private isBoundary(index: number): boolean {
    const token = this.timeline[index]?.token;
    return !!token && (token.endsSentence || token.endsParagraph);
  }

  /** Last token index of the sentence containing `index`. */
  private sentenceCapFrom(index: number): number {
    for (let i = Math.max(0, index); i < this.timeline.length; i++) {
      if (this.isBoundary(i)) return i;
    }
    return this.timeline.length - 1;
  }

  private findSentenceStart(from: number, direction: -1 | 1): number {
    if (this.timeline.length === 0) return 0;
    if (direction === 1) {
      for (let i = from; i < this.timeline.length - 1; i++) {
        if (this.isBoundary(i)) return i + 1;
      }
      return this.timeline.length - 1;
    }
    // direction === -1: go to the current sentence's start, or the previous
    // one if already at a start.
    let currentStart = 0;
    for (let i = 0; i < from; i++) {
      if (this.isBoundary(i)) currentStart = i + 1;
    }
    if (currentStart < from) return currentStart;
    let previousStart = 0;
    for (let i = 0; i < currentStart - 1; i++) {
      if (this.isBoundary(i)) previousStart = i + 1;
    }
    return previousStart;
  }
}
