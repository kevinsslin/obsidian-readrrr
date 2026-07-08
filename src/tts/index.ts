import type { TtsProvider } from "./types";
import { WebSpeechProvider } from "./webspeech";

/** All TTS providers usable in the current runtime. */
export function availableProviders(): TtsProvider[] {
  const providers: TtsProvider[] = [];
  const webSpeech = new WebSpeechProvider();
  if (webSpeech.isAvailable()) providers.push(webSpeech);
  return providers;
}

export type {
  TtsProvider,
  TtsSession,
  TtsEvents,
  TtsVoice,
  SpeakOptions,
  SpeechSynthesisLike,
  SpeechUtteranceLike,
} from "./types";
export { DEFAULT_SPEAK_OPTIONS } from "./types";
export { WebSpeechProvider } from "./webspeech";
export { buildUtterances, charIndexToRelToken } from "./chunker";
export type { Utterance } from "./chunker";
export { wpmToRate, clamp } from "./rate";
