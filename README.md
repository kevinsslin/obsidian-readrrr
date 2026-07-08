# RSVP Reader

RSVP speed reading for [Obsidian](https://obsidian.md), with an optional voice narrator synced to the words. Works on desktop and mobile.

![CI](https://github.com/kevinsslin/obsidian-rsvp-reader/actions/workflows/ci.yml/badge.svg)

RSVP Reader shows one word at a time at a fixed point on screen, with a single letter highlighted as your eye's anchor. Your eyes stop moving, so you read faster. Turn on narration and a voice reads along, kept in sync with the flashed words, so you get both channels at once.

## Features

- **RSVP display** with a Spritz-style optimal recognition point (the highlighted anchor letter stays in a fixed column for every word).
- **Synced narration** using your system's text-to-speech voices. The audio owns the pace: the display never runs past the sentence being spoken, and the voice is never cut off mid-sentence.
- **Follow along in the note**: toggle the file button and your note scrolls with the reading, the current sentence colored and kept vertically centered. Works in editing/Live Preview and in Reading view (via the CSS Custom Highlight API). It is a non-destructive overlay: your own `==highlights==` and content are untouched.
- **Hold to read**: press and hold the word area to read while held; release to pause exactly where you landed. Tap to toggle play/pause.
- **Seekable progress bar**: click or drag to scrub anywhere in the note.
- **Reads your notes**: the whole note, or just the current selection. Markdown, frontmatter, and code blocks are handled sensibly.
- **Punctuation-aware pacing**: longer words and clause, sentence, and paragraph endings get a little more time, so it does not feel robotic.
- **Live speed control** from 100 to 1000 words per minute, with a speed bar you can hide.
- **Keyboard driven**: play, pause, step by word or sentence, and change speed without touching the mouse.
- **Theme-aware**: follows your active Obsidian theme, light or dark.
- **Cross-platform**: one plugin for Obsidian on macOS, Windows, Linux, iPhone, and iPad. No Intel Mac or platform restriction.

## Install

RSVP Reader is not yet in the community plugin directory. Until then:

**Manual install**

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/kevinsslin/obsidian-rsvp-reader/releases).
2. Put them in `<your vault>/.obsidian/plugins/rsvp-reader/`.
3. In Obsidian, open **Settings → Community plugins**, turn off Restricted Mode if needed, and enable **RSVP Reader**.

**Via BRAT** (for beta testers): add `kevinsslin/obsidian-rsvp-reader` in the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin.

## Usage

Open a note, then start reading in any of these ways:

- Click the **gauge icon** in the left ribbon.
- Run **RSVP Reader: read current note** from the command palette.
- Select text and run **RSVP Reader: read selection**.

The reader opens in its own pane. Click the word (or press space) to play and pause.

### Controls

| Control | Action |
| --- | --- |
| Play / pause button, or **space** | Start or pause reading |
| Tap the word | Toggle play / pause |
| **Press and hold the word** | Read while held, pause on release |
| Restart button | Jump back to the first word |
| **← / →** | Step one word back or forward |
| **Shift + ← / →**, or the sentence buttons | Jump to the previous or next sentence |
| **↑ / ↓** | Increase or decrease speed by 10 wpm |
| Voice button | Toggle narration on or off |
| File button | Toggle **Follow in note** (auto-scroll + sentence highlight) |
| Progress bar | Click or drag to scrub |
| Speed bar | Set words per minute |

### Settings

Reading speed, word size, and whether the speed bar shows. Follow along in the note (auto-scroll and sentence highlight). Whether to skip code blocks and frontmatter. Narration on or off, voice, pitch, and volume. Advanced pacing controls (long-word timing and the clause, sentence, and paragraph pauses) with a reset button. Changes apply to an open reader immediately.

## How narration stays in sync

Narration uses the browser [Web Speech API](https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesis) that Obsidian exposes. RSVP Reader speaks one sentence at a time, and the audio owns the clock:

- **Word boundaries** (fine sync): when the speech engine reports each spoken word, the display snaps to it. These events fire reliably for on-device voices; on desktop Chromium they do not fire for network voices (a long-standing Chromium limitation).
- **Sentence ends** (the reliable fallback): every sentence, the display resyncs to the voice.
- **Never ahead, never cut off**: the display can pace words within the sentence being spoken but parks at its end until the voice finishes it, and only the voice can finish the run, so narration is never cancelled mid-sentence.

**Follow in note** highlights the current sentence in your note and keeps it centered. In editing/Live Preview it uses an editor decoration; in Reading view it locates the sentence text in the rendered page and colors it with the CSS Custom Highlight API. Both are overlays: nothing is written into your note, and your own `==highlights==` keep their normal color (the follow tint is deliberately different).

Notes:

- On **iOS**, audio must start from a tap or key press. Start narration with the play button or the Voice toggle in the reader, not only from settings.
- Prefer voices marked **on-device** for the tightest word-level sync.
- Speed changes take effect for the voice on the next play.

## Privacy

RSVP Reader reads the note you point it at and sends that text to your device's speech engine only when narration is on. On-device voices never leave your machine. Some system voices are network-backed (your OS sends text to the voice provider to synthesize audio); those are labelled accordingly in the voice picker. The plugin makes no other network requests and stores its settings locally in your vault. Reading without narration is fully offline.

## Development

Requirements: Node 18 or newer.

```bash
npm install
npm test          # unit + integration tests (vitest)
npm run typecheck # tsc, no emit
npm run lint      # eslint
npm run build     # typecheck + production bundle -> main.js
npm run check     # all of the above
npm run dev       # esbuild watch
npm run build:demo # bundle the standalone browser demo
```

**Architecture.** The reading engine is deliberately free of any `obsidian` import so it can be unit-tested in isolation and reused (the browser demo runs the same code):

- `src/core` : tokenizer (markdown to words), ORP pivot, and the WPM scheduler.
- `src/tts` : the `TtsProvider` interface and a Web Speech implementation, with an injectable synth for tests.
- `src/reader` : the playback controller. It owns an injectable clock, advances the display from an estimated timeline, and resyncs to provider events.
- `src/main.ts`, `src/settings.ts`, `src/ui` : the thin Obsidian layer (view, commands, settings).
- `demo/` : a standalone browser demo built from the same engine.

See [`docs/manual-qa.md`](docs/manual-qa.md) for the in-Obsidian test checklist.

## Credits

RSVP (rapid serial visual presentation) and the optimal-recognition-point anchor are long-standing reading techniques, popularized by [Spritz](https://spritz.com/). RSVP Reader is an independent, open-source implementation for Obsidian.

## License

[MIT](LICENSE)
