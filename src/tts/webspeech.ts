import type { Token } from "../core/types";
import type {
  TtsProvider,
  TtsSession,
  TtsEvents,
  TtsVoice,
  SpeakOptions,
  SpeechSynthesisLike,
  SpeechUtteranceLike,
} from "./types";
import { buildUtterances, charIndexToRelToken } from "./chunker";

const NOOP_SESSION: TtsSession = {
  pause() {},
  resume() {},
  stop() {},
};

function toError(ev: unknown): Error {
  if (ev instanceof Error) return ev;
  const e = ev as { error?: string } | undefined;
  return new Error(e?.error ? `Speech error: ${e.error}` : "Speech synthesis error");
}

export interface WebSpeechDeps {
  synth?: SpeechSynthesisLike;
  createUtterance?: (text: string) => SpeechUtteranceLike;
}

/**
 * TTS backed by the browser's Web Speech API (`speechSynthesis`). It speaks one
 * sentence-sized chunk at a time and reports:
 *   - `onWordSpoken` on each word-boundary event (fine sync; only fires for
 *     local voices on Chromium, more broadly on WebKit),
 *   - `onSentenceEnd` when each chunk finishes (always fires; the reliable
 *     resync point),
 *   - `onEnd` when everything is spoken.
 *
 * `speechSynthesis` and the utterance constructor are injectable so the whole
 * event flow can be tested without a browser.
 */
export class WebSpeechProvider implements TtsProvider {
  readonly id = "web-speech";
  readonly name = "System voice";

  private readonly getSynth: () => SpeechSynthesisLike | undefined;
  private readonly createUtterance: (text: string) => SpeechUtteranceLike;
  /** The current run, so a new speak() can supersede a stale one. */
  private activeRun: TtsSession | null = null;

  constructor(deps: WebSpeechDeps = {}) {
    const injected = deps.synth;
    this.getSynth = injected
      ? () => injected
      : () =>
          typeof window !== "undefined" && "speechSynthesis" in window
            ? (window.speechSynthesis as unknown as SpeechSynthesisLike)
            : undefined;
    this.createUtterance =
      deps.createUtterance ??
      ((text: string) =>
        new SpeechSynthesisUtterance(text) as unknown as SpeechUtteranceLike);
  }

  isAvailable(): boolean {
    return this.getSynth() !== undefined;
  }

  listVoices(): TtsVoice[] {
    const synth = this.getSynth();
    if (!synth) return [];
    return synth.getVoices().map((v) => ({
      id: v.voiceURI,
      label: v.name,
      lang: v.lang,
      localService: v.localService,
      isDefault: v.default,
    }));
  }

  speak(tokens: Token[], opts: SpeakOptions, events: TtsEvents): TtsSession {
    const synth = this.getSynth();
    if (!synth) {
      events.onError?.(new Error("Web Speech API is not available"));
      return NOOP_SESSION;
    }
    // Supersede any previous run so its in-flight utterances (whose onend/
    // onerror may fire from its cancel()) are suppressed. Track whether that
    // already cancelled the engine so we issue exactly one cancel per speak;
    // redundant cancel/speak churn can destabilize the OS audio daemon.
    const supersededActive = this.activeRun !== null;
    this.activeRun?.stop();
    if (tokens.length === 0) {
      events.onEnd?.();
      return NOOP_SESSION;
    }
    const startIndex = Math.max(0, Math.min(tokens.length, opts.startTokenIndex ?? 0));
    if (startIndex >= tokens.length) {
      events.onEnd?.();
      return NOOP_SESSION;
    }

    const utterances = buildUtterances(tokens.slice(startIndex), {
      maxTokensPerChunk: opts.maxTokensPerChunk,
    });
    const voice = this.resolveVoice(synth, opts.voiceId);
    let index = 0;
    let stopped = false;

    const speakNext = (): void => {
      if (stopped) return;
      if (index >= utterances.length) {
        events.onEnd?.();
        return;
      }
      const chunk = utterances[index];
      const utterance = this.createUtterance(chunk.text);
      utterance.rate = opts.rate;
      utterance.pitch = opts.pitch;
      utterance.volume = opts.volume;
      utterance.voice = voice;

      utterance.onboundary = (ev) => {
        if (stopped) return;
        if (ev.name && ev.name !== "word") return;
        const rel = charIndexToRelToken(chunk.charStarts, ev.charIndex);
        events.onWordSpoken?.(startIndex + chunk.tokenStart + rel);
      };
      utterance.onend = () => {
        if (stopped) return;
        index++;
        if (index < utterances.length) {
          events.onSentenceEnd?.(startIndex + utterances[index].tokenStart);
          speakNext();
        } else {
          events.onEnd?.();
        }
      };
      utterance.onerror = (ev) => {
        if (stopped) return;
        events.onError?.(toError(ev));
      };

      synth.speak(utterance);
    };

    const run: TtsSession = {
      pause: () => synth.pause(),
      resume: () => synth.resume(),
      stop: () => {
        stopped = true;
        if (this.activeRun === run) this.activeRun = null;
        synth.cancel();
      },
    };
    this.activeRun = run;

    // Clear anything already queued (unless superseding just did), then start.
    if (!supersededActive) synth.cancel();
    speakNext();

    return run;
  }

  private resolveVoice(
    synth: SpeechSynthesisLike,
    voiceId: string | null | undefined,
  ): SpeechSynthesisVoice | null {
    if (!voiceId) return null;
    return synth.getVoices().find((v) => v.voiceURI === voiceId) ?? null;
  }
}
