import { describe, it, expect, beforeEach } from "vitest";
import { WebSpeechProvider } from "./webspeech";
import type { SpeechSynthesisLike, SpeechUtteranceLike } from "./types";
import type { Token } from "../core/types";

function tok(text: string, flags: Partial<Token> = {}): Token {
  return { text, endsSentence: false, endsClause: false, endsParagraph: false, ...flags };
}

class FakeUtterance implements SpeechUtteranceLike {
  rate = 1;
  pitch = 1;
  volume = 1;
  voice: SpeechSynthesisVoice | null = null;
  onboundary: ((ev: { charIndex: number; name?: string }) => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(public text: string) {}
}

class FakeSynth implements SpeechSynthesisLike {
  spoken: FakeUtterance[] = [];
  canceled = 0;
  paused = 0;
  resumed = 0;
  voices: SpeechSynthesisVoice[] = [];
  speak(u: SpeechUtteranceLike): void {
    this.spoken.push(u as FakeUtterance);
  }
  cancel(): void {
    this.canceled++;
  }
  pause(): void {
    this.paused++;
  }
  resume(): void {
    this.resumed++;
  }
  getVoices(): SpeechSynthesisVoice[] {
    return this.voices;
  }
}

const OPTS = { voiceId: null, rate: 1.5, pitch: 1, volume: 1 };

function makeProvider(synth: FakeSynth) {
  return new WebSpeechProvider({
    synth,
    createUtterance: (t) => new FakeUtterance(t),
  });
}

// "One two three." then "Four five."
const TWO_SENTENCES: Token[] = [
  tok("One"),
  tok("two"),
  tok("three.", { endsSentence: true }),
  tok("Four"),
  tok("five.", { endsSentence: true }),
];

describe("WebSpeechProvider", () => {
  let synth: FakeSynth;
  beforeEach(() => {
    synth = new FakeSynth();
  });

  it("reports availability based on the synth", () => {
    expect(makeProvider(synth).isAvailable()).toBe(true);
    expect(new WebSpeechProvider().isAvailable()).toBe(false); // no window in node
  });

  it("maps voices to the normalized shape", () => {
    synth.voices = [
      {
        voiceURI: "v1",
        name: "Alex",
        lang: "en-US",
        localService: true,
        default: true,
      } as SpeechSynthesisVoice,
    ];
    expect(makeProvider(synth).listVoices()).toEqual([
      { id: "v1", label: "Alex", lang: "en-US", localService: true, isDefault: true },
    ]);
  });

  it("advances words on boundary events and sentences on end", () => {
    const words: number[] = [];
    const sentenceEnds: number[] = [];
    let ended = false;

    makeProvider(synth).speak(TWO_SENTENCES, OPTS, {
      onWordSpoken: (i) => words.push(i),
      onSentenceEnd: (i) => sentenceEnds.push(i),
      onEnd: () => {
        ended = true;
      },
    });

    // Initial cancel + first utterance queued with the requested rate.
    expect(synth.canceled).toBe(1);
    expect(synth.spoken).toHaveLength(1);
    expect(synth.spoken[0].text).toBe("One two three.");
    expect(synth.spoken[0].rate).toBe(1.5);

    // Boundary at char 4 => relative token 1 (absolute 1); char 0 => token 0.
    synth.spoken[0].onboundary!({ charIndex: 4, name: "word" });
    synth.spoken[0].onboundary!({ charIndex: 0, name: "word" });
    expect(words).toEqual([1, 0]);

    // End of first chunk speaks the next and reports its start token (3).
    synth.spoken[0].onend!();
    expect(sentenceEnds).toEqual([3]);
    expect(synth.spoken).toHaveLength(2);
    expect(synth.spoken[1].text).toBe("Four five.");

    // Boundary in second chunk: char 5 => relative token 1 (absolute 4).
    synth.spoken[1].onboundary!({ charIndex: 5, name: "word" });
    expect(words).toEqual([1, 0, 4]);

    // Final end fires onEnd, nothing more queued.
    synth.spoken[1].onend!();
    expect(ended).toBe(true);
    expect(synth.spoken).toHaveLength(2);
  });

  it("starts from an offset while keeping event indexes document-relative", () => {
    const words: number[] = [];
    makeProvider(synth).speak(TWO_SENTENCES, { ...OPTS, startTokenIndex: 4 }, {
      onWordSpoken: (index) => words.push(index),
    });
    expect(synth.spoken[0].text).toBe("five.");
    synth.spoken[0].onboundary!({ charIndex: 0, name: "word" });
    expect(words).toEqual([4]);
  });

  it("ignores non-word boundaries", () => {
    const words: number[] = [];
    makeProvider(synth).speak(TWO_SENTENCES, OPTS, { onWordSpoken: (i) => words.push(i) });
    synth.spoken[0].onboundary!({ charIndex: 4, name: "sentence" });
    expect(words).toEqual([]);
  });

  it("stops cleanly and ignores late events", () => {
    const words: number[] = [];
    let ended = false;
    const session = makeProvider(synth).speak(TWO_SENTENCES, OPTS, {
      onWordSpoken: (i) => words.push(i),
      onEnd: () => {
        ended = true;
      },
    });

    session.stop();
    expect(synth.canceled).toBe(2); // one on start, one on stop
    // Events arriving after stop are ignored.
    synth.spoken[0].onboundary!({ charIndex: 4, name: "word" });
    synth.spoken[0].onend!();
    expect(words).toEqual([]);
    expect(ended).toBe(false);
  });

  it("pause and resume delegate to the synth", () => {
    const session = makeProvider(synth).speak(TWO_SENTENCES, OPTS, {});
    session.pause();
    session.resume();
    expect(synth.paused).toBe(1);
    expect(synth.resumed).toBe(1);
  });

  it("selects a voice by id", () => {
    synth.voices = [
      { voiceURI: "v1", name: "A", lang: "en", localService: true, default: false } as SpeechSynthesisVoice,
      { voiceURI: "v2", name: "B", lang: "en", localService: false, default: true } as SpeechSynthesisVoice,
    ];
    makeProvider(synth).speak([tok("hi.", { endsSentence: true })], { ...OPTS, voiceId: "v2" }, {});
    expect(synth.spoken[0].voice?.voiceURI).toBe("v2");
  });

  it("supersedes a previous run so its late callbacks are ignored", () => {
    const provider = makeProvider(synth);
    let firstSentenceEnds = 0;
    let firstEnded = false;
    provider.speak(TWO_SENTENCES, OPTS, {
      onSentenceEnd: () => firstSentenceEnds++,
      onEnd: () => {
        firstEnded = true;
      },
    });
    const firstUtterance = synth.spoken[0];

    // Start a new run WITHOUT stopping the first one.
    provider.speak([tok("Hi.", { endsSentence: true })], OPTS, {});
    expect(synth.spoken).toHaveLength(2);

    // The stale run's end event must be ignored (no callbacks, no re-queue).
    firstUtterance.onend!();
    expect(firstSentenceEnds).toBe(0);
    expect(firstEnded).toBe(false);
    expect(synth.spoken).toHaveLength(2);
  });

  it("emits onEnd immediately for empty input", () => {
    let ended = false;
    makeProvider(synth).speak([], OPTS, { onEnd: () => (ended = true) });
    expect(ended).toBe(true);
    expect(synth.spoken).toHaveLength(0);
  });
});
