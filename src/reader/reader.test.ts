import { describe, it, expect, beforeEach } from "vitest";
import { Reader } from "./reader";
import type { Clock } from "./clock";
import { DEFAULT_TIMING, type TimingOptions } from "../core/scheduler";
import type { Token } from "../core/types";
import type { TtsProvider, TtsEvents, SpeakOptions } from "../tts/types";

function tok(text: string, flags: Partial<Token> = {}): Token {
  return { text, endsSentence: false, endsClause: false, endsParagraph: false, ...flags };
}

// wpm 300 => 200ms per plain word, no punctuation modifiers.
const TIMING: TimingOptions = { ...DEFAULT_TIMING, wpm: 300 };

/** A clock whose time only moves when the test advances it, firing due timers. */
class FakeClock implements Clock {
  private t = 0;
  private nextId = 1;
  private timers = new Map<number, { due: number; fn: () => void }>();

  now(): number {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number): number {
    const id = this.nextId++;
    this.timers.set(id, { due: this.t + Math.max(0, ms), fn });
    return id;
  }
  clearTimeout(handle: number): void {
    this.timers.delete(handle);
  }
  advance(ms: number): void {
    const target = this.t + ms;
    for (;;) {
      let nextId: number | null = null;
      let nextDue = Infinity;
      for (const [id, timer] of this.timers) {
        if (timer.due <= target && timer.due < nextDue) {
          nextDue = timer.due;
          nextId = id;
        }
      }
      if (nextId === null) break;
      const timer = this.timers.get(nextId)!;
      this.timers.delete(nextId);
      this.t = timer.due;
      timer.fn();
    }
    this.t = target;
  }
}

/** Provider that captures the events so the test can fire them by hand. */
class FakeProvider implements TtsProvider {
  readonly id = "fake";
  readonly name = "Fake";
  events: TtsEvents | null = null;
  spokenTokens: Token[] | null = null;
  stopped = 0;
  speakCount = 0;
  lastRate = 0;
  isAvailable(): boolean {
    return true;
  }
  listVoices() {
    return [];
  }
  speak(tokens: Token[], opts: SpeakOptions, events: TtsEvents) {
    this.events = events;
    this.spokenTokens = tokens;
    this.speakCount++;
    this.lastRate = opts.rate;
    return {
      pause: () => {},
      resume: () => {},
      stop: () => {
        this.stopped++;
      },
    };
  }
}

const SPEAK: SpeakOptions = { voiceId: null, rate: 1, pitch: 1, volume: 1 };

describe("Reader: silent playback", () => {
  let clock: FakeClock;
  let reader: Reader;
  let rendered: number[];
  let finished: boolean;

  beforeEach(() => {
    clock = new FakeClock();
    reader = new Reader(clock);
    rendered = [];
    finished = false;
    reader.setListeners({
      onWord: (entry) => rendered.push(entry.index),
      onFinish: () => {
        finished = true;
      },
    });
  });

  const fiveWords = () => [tok("one"), tok("two"), tok("three"), tok("four"), tok("five")];

  it("renders the first word on load and stays idle", () => {
    reader.load(fiveWords(), TIMING);
    expect(rendered).toEqual([0]);
    expect(reader.getState()).toMatchObject({ status: "idle", index: 0, total: 5 });
  });

  it("advances through words in order and finishes", () => {
    reader.load(fiveWords(), TIMING);
    reader.play();
    clock.advance(1000); // 5 words * 200ms
    // non-decreasing progression 0..4
    expect(rendered[0]).toBe(0);
    for (let i = 1; i < rendered.length; i++) {
      expect(rendered[i]).toBeGreaterThanOrEqual(rendered[i - 1]);
    }
    expect(rendered[rendered.length - 1]).toBe(4);
    expect(finished).toBe(true);
    expect(reader.getState().status).toBe("finished");
  });

  it("emits state updates as words advance during playback", () => {
    const playingIndexes: number[] = [];
    reader.setListeners({
      onWord: (entry) => rendered.push(entry.index),
      onState: (state) => {
        if (state.status === "playing") playingIndexes.push(state.index);
      },
      onFinish: () => {
        finished = true;
      },
    });

    reader.load(fiveWords(), TIMING);
    reader.play();
    clock.advance(450); // crosses word indexes 1 and 2, but does not finish

    expect(playingIndexes).toEqual([0, 1, 2]);
    expect(finished).toBe(false);
  });

  it("pauses and resumes without losing position", () => {
    reader.load(fiveWords(), TIMING);
    reader.play();
    clock.advance(250); // into word index 1
    expect(reader.getState().index).toBe(1);

    reader.pause();
    clock.advance(5000); // time passes but paused
    expect(reader.getState().index).toBe(1);
    expect(finished).toBe(false);

    reader.play();
    clock.advance(200); // now at ~450ms -> index 2
    expect(reader.getState().index).toBe(2);
  });

  it("changes timing mid-run without losing position", () => {
    reader.load(fiveWords(), TIMING); // 200ms per word
    reader.play();
    clock.advance(450); // -> index 2
    expect(reader.getState().index).toBe(2);

    reader.setTiming({ ...TIMING, wpm: 600 }); // now 100ms per word
    expect(reader.getState().index).toBe(2); // position preserved

    clock.advance(100); // one new (faster) word
    expect(reader.getState().index).toBe(3);
  });

  it("seeks to an index and renders it", () => {
    reader.load(fiveWords(), TIMING);
    reader.seekToIndex(3);
    expect(rendered[rendered.length - 1]).toBe(3);
    expect(reader.getState().index).toBe(3);
  });

  it("stops and resets to the first word", () => {
    reader.load(fiveWords(), TIMING);
    reader.play();
    clock.advance(450);
    reader.stop();
    expect(reader.getState()).toMatchObject({ status: "idle", index: 0 });
    expect(rendered[rendered.length - 1]).toBe(0);
  });
});

describe("Reader: sentence seeking", () => {
  it("jumps to the next and previous sentence starts", () => {
    const reader = new Reader(new FakeClock());
    // "A b." | "C d." -> sentence starts at 0 and 2
    reader.load(
      [tok("A"), tok("b.", { endsSentence: true }), tok("C"), tok("d.", { endsSentence: true })],
      TIMING,
    );
    reader.seekBySentence(1);
    expect(reader.getState().index).toBe(2);
    reader.seekBySentence(-1);
    expect(reader.getState().index).toBe(0);
  });
});

describe("Reader: narration resync", () => {
  it("snaps the display to provider word and sentence events", () => {
    const clock = new FakeClock();
    const reader = new Reader(clock);
    const provider = new FakeProvider();
    const rendered: number[] = [];
    const stateIndexes: number[] = [];
    let finished = false;
    reader.setListeners({
      onWord: (entry) => rendered.push(entry.index),
      onState: (state) => stateIndexes.push(state.index),
      onFinish: () => {
        finished = true;
      },
    });

    // two sentences of three words each
    reader.load(
      [
        tok("one"),
        tok("two"),
        tok("three.", { endsSentence: true }),
        tok("four"),
        tok("five"),
        tok("six.", { endsSentence: true }),
      ],
      TIMING,
    );
    reader.setNarration({ provider, speak: SPEAK });
    reader.play();

    // Provider started speaking from index 0 (whole doc).
    expect(provider.spokenTokens).toHaveLength(6);
    expect(provider.events).not.toBeNull();

    // A word-boundary for token 2 snaps the display there.
    provider.events!.onWordSpoken!(2);
    expect(reader.getState().index).toBe(2);

    // Sentence end reports the next sentence start (token 3).
    provider.events!.onSentenceEnd!(3);
    expect(reader.getState().index).toBe(3);
    expect(stateIndexes).toContain(2);
    expect(stateIndexes).toContain(3);

    // Audio end finishes the run.
    provider.events!.onEnd!();
    expect(finished).toBe(true);
    expect(reader.getState().status).toBe("finished");
    expect(rendered).toContain(2);
    expect(rendered).toContain(3);
  });

  it("stops the TTS session on pause and stop", () => {
    const clock = new FakeClock();
    const reader = new Reader(clock);
    const provider = new FakeProvider();
    reader.load([tok("hi."), tok("bye.", { endsSentence: true })], TIMING);
    reader.setNarration({ provider, speak: SPEAK });

    reader.play();
    reader.pause();
    expect(provider.stopped).toBe(1);

    reader.play();
    reader.stop();
    expect(provider.stopped).toBe(2);
  });

  it("never cuts off audio: waits at sentence boundaries and only audio finishes", () => {
    const clock = new FakeClock();
    const reader = new Reader(clock);
    const provider = new FakeProvider();
    let finished = false;
    reader.setListeners({ onFinish: () => (finished = true) });

    // Two sentences of three words each; estimated pace = 200ms/word.
    reader.load(
      [
        tok("one"),
        tok("two"),
        tok("three.", { endsSentence: true }),
        tok("four"),
        tok("five"),
        tok("six.", { endsSentence: true }),
      ],
      TIMING,
    );
    reader.setNarration({ provider, speak: SPEAK });
    reader.play();

    // Estimated clock runs far past everything; with audio active it must park
    // at the end of the CURRENT sentence, not finish, not stop the session.
    clock.advance(60_000);
    expect(reader.getState().status).toBe("playing");
    expect(reader.getState().index).toBe(2); // parked at "three."
    expect(finished).toBe(false);
    expect(provider.stopped).toBe(0);

    // Audio finishes sentence 1: display moves to sentence 2 and parks at its end.
    provider.events!.onSentenceEnd!(3);
    clock.advance(60_000);
    expect(reader.getState().index).toBe(5);
    expect(finished).toBe(false);

    // Only the audio's end finishes the run.
    provider.events!.onEnd!();
    expect(finished).toBe(true);
    expect(reader.getState().status).toBe("finished");
  });

  it("pausing while parked resumes at the boundary, not inflated by wall time", () => {
    const clock = new FakeClock();
    const reader = new Reader(clock);
    const provider = new FakeProvider();
    reader.load(
      [tok("a"), tok("b.", { endsSentence: true }), tok("c"), tok("d.", { endsSentence: true })],
      TIMING,
    );
    reader.setNarration({ provider, speak: SPEAK });
    reader.play();
    clock.advance(30_000); // parked at index 1 (end of first sentence)
    expect(reader.getState().index).toBe(1);

    reader.pause();
    reader.play(); // restarts narration from index 1
    clock.advance(50);
    // Still within the first sentence's cap; must not have leapt to the end.
    expect(reader.getState().index).toBe(1);
    expect(reader.getState().status).toBe("playing");
  });

  it("recovers cleanly from a provider that errors synchronously inside speak()", () => {
    class SyncErrorProvider extends FakeProvider {
      speak(tokens: Token[], opts: SpeakOptions, events: TtsEvents) {
        const session = super.speak(tokens, opts, events);
        events.onError?.(new Error("no voice"));
        return session;
      }
    }
    const clock = new FakeClock();
    const reader = new Reader(clock);
    const provider = new SyncErrorProvider();
    const rendered: number[] = [];
    let finishCount = 0;
    reader.setListeners({
      onWord: (entry) => rendered.push(entry.index),
      onFinish: () => finishCount++,
    });
    reader.load([tok("one"), tok("two"), tok("three.", { endsSentence: true })], TIMING);
    reader.setNarration({ provider, speak: SPEAK });
    reader.play();
    clock.advance(5_000);

    expect(finishCount).toBe(1); // exactly one finish, no double-timer races
    for (let i = 1; i < rendered.length; i++) {
      expect(rendered[i]).toBeGreaterThanOrEqual(rendered[i - 1]);
    }
    expect(reader.getState().status).toBe("finished");
  });

  it("keeps waiting for audio when timing changes while parked", () => {
    const clock = new FakeClock();
    const reader = new Reader(clock);
    const provider = new FakeProvider();
    let finished = false;
    reader.setListeners({ onFinish: () => (finished = true) });
    reader.load(
      [tok("one"), tok("two.", { endsSentence: true }), tok("three"), tok("four.", { endsSentence: true })],
      TIMING,
    );
    reader.setNarration({ provider, speak: SPEAK });
    reader.play();
    clock.advance(30_000); // parked at index 1 waiting for audio
    expect(reader.getState().index).toBe(1);

    reader.setTiming({ ...TIMING, wpm: 600 }); // WPM change mid-wait
    clock.advance(30_000);
    // Still parked at the boundary; the run is not finished and audio owns it.
    expect(reader.getState().index).toBe(1);
    expect(reader.getState().status).toBe("playing");
    expect(finished).toBe(false);

    provider.events!.onSentenceEnd!(2);
    provider.events!.onEnd!();
    expect(finished).toBe(true);
  });

  it("falls back to the estimated clock when narration errors", () => {
    const clock = new FakeClock();
    const reader = new Reader(clock);
    const provider = new FakeProvider();
    let finished = false;
    reader.setListeners({ onFinish: () => (finished = true) });
    reader.load(
      [tok("one"), tok("two"), tok("three.", { endsSentence: true })],
      TIMING,
    );
    reader.setNarration({ provider, speak: SPEAK });
    reader.play();

    provider.events!.onError!(new Error("voice failed"));
    clock.advance(5_000); // estimated clock now owns the run and finishes it
    expect(finished).toBe(true);
    expect(reader.getState().status).toBe("finished");
  });

  it("turning narration off while parked resumes the estimated clock", () => {
    const clock = new FakeClock();
    const reader = new Reader(clock);
    const provider = new FakeProvider();
    let finished = false;
    reader.setListeners({ onFinish: () => (finished = true) });
    reader.load(
      [tok("one"), tok("two.", { endsSentence: true }), tok("three"), tok("four.", { endsSentence: true })],
      TIMING,
    );
    reader.setNarration({ provider, speak: SPEAK });
    reader.play();
    clock.advance(30_000); // parked at index 1
    expect(reader.getState().index).toBe(1);

    reader.setNarration(null); // voice off: estimated clock takes over
    clock.advance(5_000);
    expect(finished).toBe(true);
  });

  it("does not restart the audio when narration is re-applied unchanged", () => {
    const reader = new Reader(new FakeClock());
    const provider = new FakeProvider();
    reader.load([tok("a"), tok("b.", { endsSentence: true })], TIMING);
    reader.setNarration({ provider, speak: { ...SPEAK, rate: 1.5 } });
    reader.play();
    expect(provider.speakCount).toBe(1);

    // Same provider, identical audible options: must be a no-op.
    reader.setNarration({ provider, speak: { ...SPEAK, rate: 1.5 } });
    reader.setNarration({ provider, speak: { ...SPEAK, rate: 1.5 } });
    expect(provider.speakCount).toBe(1);
    expect(provider.stopped).toBe(0);
  });

  it("coalesces a burst of seeks into a single narration restart", () => {
    const clock = new FakeClock();
    const reader = new Reader(clock);
    const provider = new FakeProvider();
    reader.load(
      [
        tok("one"),
        tok("two"),
        tok("three.", { endsSentence: true }),
        tok("four"),
        tok("five"),
        tok("six.", { endsSentence: true }),
      ],
      TIMING,
    );
    reader.setNarration({ provider, speak: SPEAK });
    reader.play();
    expect(provider.speakCount).toBe(1);

    // Held arrow key: several seeks in quick succession.
    reader.seekToIndex(1);
    reader.seekToIndex(2);
    reader.seekToIndex(3);
    expect(provider.stopped).toBe(1); // audio stopped once, immediately
    expect(provider.speakCount).toBe(1); // no restart yet

    clock.advance(250); // quiet period elapses
    expect(provider.speakCount).toBe(2); // exactly one restart
    expect(provider.spokenTokens?.[0]?.text).toBe("four"); // from the last seek
  });

  it("restarts narration at the new rate when re-set while playing", () => {
    // This is what makes a live speed change take effect on the voice: the view
    // re-applies narration on slider release, which restarts the session.
    const reader = new Reader(new FakeClock());
    const provider = new FakeProvider();
    reader.load([tok("a"), tok("b.", { endsSentence: true })], TIMING);

    reader.setNarration({ provider, speak: { ...SPEAK, rate: 1 } });
    reader.play();
    expect(provider.speakCount).toBe(1);
    expect(provider.lastRate).toBe(1);

    reader.setNarration({ provider, speak: { ...SPEAK, rate: 2 } });
    expect(provider.stopped).toBe(1); // old session stopped
    expect(provider.speakCount).toBe(2); // new session started
    expect(provider.lastRate).toBe(2); // at the new rate
  });

  it("ignores events from a session stopped by pause (no stale finish/snap)", () => {
    const clock = new FakeClock();
    const reader = new Reader(clock);
    const provider = new FakeProvider();
    let finished = false;
    reader.setListeners({ onFinish: () => (finished = true) });
    reader.load([tok("one"), tok("two"), tok("three.", { endsSentence: true })], TIMING);
    reader.setNarration({ provider, speak: SPEAK });

    reader.play();
    const staleEvents = provider.events!;
    reader.pause();
    const indexAfterPause = reader.getState().index;

    // A late event from the stopped session must be ignored.
    staleEvents.onEnd!();
    expect(finished).toBe(false);
    expect(reader.getState().status).toBe("paused");

    staleEvents.onWordSpoken!(2);
    expect(reader.getState().index).toBe(indexAfterPause);
  });

  it("handles a provider that finishes synchronously inside speak()", () => {
    class SyncEndProvider extends FakeProvider {
      speak(tokens: Token[], opts: SpeakOptions, events: TtsEvents) {
        const session = super.speak(tokens, opts, events);
        events.onEnd?.(); // completes before returning the session
        return session;
      }
    }
    const reader = new Reader(new FakeClock());
    const provider = new SyncEndProvider();
    let finishCount = 0;
    reader.setListeners({ onFinish: () => finishCount++ });
    reader.load([tok("hi.", { endsSentence: true })], TIMING);
    reader.setNarration({ provider, speak: SPEAK });

    reader.play();
    expect(finishCount).toBe(1);
    expect(reader.getState().status).toBe("finished");
    expect(provider.stopped).toBe(1); // the synchronously-ended session is stopped
  });
});

describe("Reader: reentrant listeners", () => {
  it("survives a listener that stops playback during onWord", () => {
    const clock = new FakeClock();
    const reader = new Reader(clock);
    const seen: number[] = [];
    let finished = false;
    reader.setListeners({
      onWord: (entry) => {
        seen.push(entry.index);
        if (entry.index === 2) reader.stop();
      },
      onFinish: () => (finished = true),
    });
    reader.load([tok("a"), tok("b"), tok("c"), tok("d"), tok("e")], TIMING);
    reader.play();
    clock.advance(3000); // well past the whole run

    // stop() fired at index 2 -> reset to idle at 0, no finish, no zombie timer.
    expect(seen).toContain(2);
    expect(finished).toBe(false);
    expect(reader.getState()).toMatchObject({ status: "idle", index: 0 });
  });
});
