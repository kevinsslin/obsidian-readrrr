# Better narration voices: provider research

Research notes for replacing or augmenting the Web Speech system voices with
natural-sounding TTS for long-form listening (blogs, newsletters, ebooks),
while keeping the word-synced RSVP display. Compiled 2026-07-14.

## The constraint that shapes everything: word timestamps

The reader treats audio as the master clock. A provider plugs in by firing
`onWordSpoken(tokenIndex)` at the right moments (see `src/tts/types.ts`).
Web Speech gives us live `boundary` events; cloud providers instead return
**word timestamps with the audio**, which is strictly better: sync becomes
deterministic (drive events from `audio.currentTime` against the timestamp
table), seeking inside a chunk becomes possible, and `playbackRate` handles
WPM changes without re-synthesis (browsers pitch-correct by default).

Providers with no timestamps can still work at sentence granularity (the
estimated clock paces within a sentence and resyncs at chunk ends), which is
exactly today's fallback behavior when boundary events do not fire.

## What the acclaimed apps actually use

- **Readwise Reader** uses **Unreal Speech**, generated server-side on
  request, with "accurate word mapping enabling immersion reading" (their
  word-level highlight). Verified from Readwise's own
  [TTS docs](https://docs.readwise.io/reader/docs/faqs/text-to-speech) and
  the [Dec 2023 changelog](https://readwise.io/reader/update-dec2023) that
  introduced "Unreal TTS".
- **ElevenReader** is ElevenLabs' own app (their voices, first-party).
- **Matter** upgraded voices in Sept 2025 but does not name the provider.
- Obsidian prior art:
  [Aloud](https://github.com/adrianlyjak/obsidian-aloud-tts) streams
  OpenAI-compatible TTS sentence-by-sentence with caching, but only
  **sentence-level** highlight (consistent with OpenAI's lack of
  timestamps); [obsidian-edge-tts](https://github.com/travisvn/obsidian-edge-tts)
  uses the free Edge Read Aloud endpoint;
  [VoxTrack](https://github.com/tanyangkai/voxtrack) achieves **word-level
  highlight** from Edge TTS word-boundary metadata, proving word sync from
  network TTS works inside the Obsidian webview. The community catalog has
  [8 TTS plugins](https://www.obsidianstats.com/tags/text-to-speech) total;
  none combine RSVP with word-synced audio, so this remains a differentiator.

## Provider survey

Rough cost intuition: spoken audio runs ≈ 50–55K characters per hour, so
$16/1M chars ≈ $0.85 per listening hour.

| Provider | Word timing | Mechanism | Price (per 1M chars ≈ 18h) | Browser/webview fit |
|---|---|---|---|---|
| **Unreal Speech** | Yes | V8 `TimestampType: word` on `/speech` (≤3K chars) and `/synthesisTasks` (≤500K); returns `TimestampsUri` JSON with per-word start/end ([docs](https://docs.v8.unrealspeech.com)) | ~$16 entry tier ($49/mo for 3M), 250K free ([pricing](https://app.unrealspeech.com/pricing)) | Plain REST + bearer key; trivial via `requestUrl` |
| **Azure Speech** | Yes | `wordBoundary` events with `audioOffset` (100ns ticks) in the official browser JS SDK ([SpeechSynthesisWordBoundaryEventArgs](https://learn.microsoft.com/en-us/javascript/api/microsoft-cognitiveservices-speech-sdk/speechsynthesiswordboundaryeventargs)) | $16 neural, $22 HD; **F0 free tier ≈ 500K neural chars/month** ([pricing](https://azure.microsoft.com/en-us/pricing/details/speech/)) | Official JS SDK runs in browsers (websocket); adds a real dependency; Azure signup is the friction |
| **ElevenLabs** | Yes (char-level) | `/v1/text-to-speech/{voice}/with-timestamps` returns per-character start/end seconds; aggregate to words ([API ref](https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps); a streaming variant exists in the same API family) | Flash ≈ $50 ($2.7/h); Multilingual v2 ≈ 2×; subscription credits ([API pricing](https://elevenlabs.io/pricing/api)) | Plain REST + `xi-api-key`; trivial via `requestUrl` |
| **OpenAI** | **No** | No timestamp mechanism on `tts-1`/`gpt-4o-mini-tts` ([model page](https://platform.openai.com/docs/models/gpt-4o-mini-tts)) | gpt-4o-mini-tts ≈ $0.015/min ≈ $0.90/h; steerable tone; streaming | Plain REST; many users already hold keys; sentence-level sync only |
| **Edge TTS (free, unofficial)** | Yes | WordBoundary metadata over the Read Aloud websocket | Free; Microsoft tightened access from Dec 2025 (10-min caps, breakages) per [obsidian-edge-tts](https://github.com/travisvn/obsidian-edge-tts) | Works (two plugins ship it) but can break at any time; not a foundation |
| **Cartesia** | Yes | Word timestamps on Sonic ([pricing](https://www.cartesia.ai/pricing)) | ~$5–37 by plan tier | Fine, but credit plans target realtime agents, not long-form listening |
| **Kokoro-82M local** | Not exposed | [kokoro-js](https://github.com/hexgrad/kokoro/tree/main/kokoro.js): 82M params, WASM/WebGPU via transformers.js, streaming text in; Apache-2.0 | Free, offline | Plausible on desktop Electron; unproven in the iOS webview (memory/perf); no word timestamps today → estimated sync only |

Not shortlisted: **Amazon Polly** has exactly the right mechanism (speech
marks) but BYO-key from a webview means implementing SigV4 request signing,
which is hostile UX and code; **Google Cloud TTS** only yields timepoints for
SSML `<mark/>` tags on the v1beta1 API, so word timing requires injecting a
mark per word; **Deepgram Aura** documents no word-timestamp mechanism for
TTS; **MiniMax / Hume / PlayHT** were not deeply verified and offer no clear
advantage for this use case over the shortlist.

## iOS findings

- **Enhanced system voices are not a reliable free upgrade.** iOS exposes
  only a subset of installed voices to Web Speech in WebKit; downloaded
  enhanced/premium voices frequently do not appear
  ([Apple dev forums](https://developer.apple.com/forums/thread/723503),
  [talkr field notes](https://talkrapp.com/speechSynthesis.html)). Worth one
  device test in Obsidian's webview, but do not build the plan on it.
- **Backgrounding:** `speechSynthesis` on iOS stops (and can wedge) when the
  app backgrounds mid-utterance. Whether an `HTMLAudioElement` keeps playing
  under Obsidian iOS (which would need the audio background mode in the host
  app) is untested; needs a device check. Screen-on listening works either
  way.
- Cloud providers are reachable from mobile via `requestUrl` (no CORS), so
  the timestamped-audio approach works on iPhone for foreground use.

## Recommendation

Build one shared `TimestampedAudioProvider` engine, then add thin per-vendor
adapters. The engine owns: chunking (sentence-sized, provider char limits),
synthesis via `requestUrl`, one reused `HTMLAudioElement` with a timestamp-table
driver emitting `onWordSpoken`/`onSentenceEnd`, prefetch of
chunk N+1 during playback, `playbackRate` mapping from the WPM slider
(timestamps scale by 1/rate), and an audio+timestamps cache keyed by
hash(chunk, provider, voice, rate-independent settings) so recent re-listens
avoid another request. Pause/resume/stop map directly onto the audio element,
which is more robust than the `speechSynthesis` state machine.

Adapter order:

1. **Unreal Speech** first: simplest integration (REST + word-timestamp
   JSON), mid-tier price, free 250K chars to trial, and it is the engine
   behind the exact product experience this plugin replicates.
2. **ElevenLabs** second: quality ceiling for users who want the best and
   will pay; char-to-word aggregation is straightforward.
3. **Azure** third: best economics for heavy listeners (free 500K/month,
   $16/1M) and a huge voice/language catalog, at the cost of bundling the
   Speech SDK and Azure signup friction.
4. **OpenAI** fourth, clearly labeled "sentence sync": cheapest hosted
   option, many users already have keys, and an OpenAI-compatible base-URL
   setting covers local servers and proxies for free.

Skip for now: Edge TTS (breakage risk as a dependency; revisit if users ask),
Kokoro local (revisit when word timing is exposed or for a desktop-only
offline mode with estimated sync), Cartesia/others (no differentiator).

Settings shape: a narration provider dropdown (System voice / Unreal now;
ElevenLabs / Azure / OpenAI can be added later), with per-provider API key and
voice controls. Obsidian 1.11.4 or newer stores keys in SecretStorage. The plugin
never falls back to plaintext plugin data.

## Open questions for device testing

1. Does `HTMLAudioElement` playback continue when Obsidian iOS backgrounds?
2. Do downloaded enhanced iOS voices appear in `getVoices()` inside
   Obsidian's webview on current iOS?
3. Real-world Unreal Speech latency per sentence chunk (prefetch depth).
