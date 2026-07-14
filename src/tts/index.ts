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
export { UnrealSpeechProvider, UNREAL_DEFAULT_BASE_URL } from "./unreal";
export type { UnrealHttp, UnrealSpeechConfig } from "./unreal";
export { TimedAudioSession, mapWordsToTokens } from "./timed-audio";
export type {
  SynthesizedChunk,
  AudioLike,
  TimedAudioDeps,
  TimedAudioSessionConfig,
} from "./timed-audio";
export { buildUtterances, charIndexToRelToken } from "./chunker";
export type { Utterance } from "./chunker";
export { wpmToRate, clamp } from "./rate";
export {
  IndexedDbNarrationCache,
  persistentCacheKey,
  requestPersistentStorage,
} from "./persistent-cache";
export type {
  PersistentNarrationCache,
  NarrationCacheStats,
  PersistentCacheKeyOptions,
} from "./persistent-cache";
