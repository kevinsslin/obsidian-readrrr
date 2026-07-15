# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-07-15

### Added

- One-tap locate: a new crosshair button jumps the note to the current word
  and marks it with a strong accent flash for a few seconds (softer sentence
  tint around it), in both editing view and Reading view.
- Locate on pause (default on): pausing flashes the current word in the note,
  so stopping always answers "where was I?". It never steals focus; on phones
  it also positions the hidden note tab so switching to it lands on the spot.
- The note inside the reader: an optional split within the reader pane, the
  note's rendered text on top and the flashed word below, following along with
  the same centered sentence highlight. Obsidian cannot split the workspace on
  phones, so this is on by default there ("Automatic"), with Always and Never
  options plus a book toolbar button for a session override.

### Changed

- Locate and the pause flash target the embedded pane directly when it is
  open, instead of switching to the note's tab.

### Fixed

- Numeric settings sliders now show an always-visible exact value that updates
  while dragging, instead of requiring users to infer settings from thumb position.

## [0.2.0] - 2026-07-15

### Added

- Natural cloud narration through Unreal Speech, the TTS engine used by Readwise
  Reader. Users can choose the free system voice or supply their own Unreal
  Speech API key and select from its multilingual voice catalog.
- Exact word synchronization for cloud narration from provider-supplied audio
  timestamps, with startup buffering, rolling prefetch, and layered caches.
- Device-local persistent narration caching through IndexedDB, with configurable
  storage limits, LRU eviction, usage statistics, and a clear-cache control.
- Automatic per-note reading checkpoints that resume after reopening a note and
  survive note edits through source offsets, token anchors, and progress fallback.
- Live book statistics for word count, completion percentage, remaining time at
  the current WPM, and estimated 128 kbps narration size.

### Changed

- Unreal Speech now groups short sentences into larger chunks, buffers two
  chunks before starting, and keeps a two-chunk lookahead so high-WPM playback
  does not pause at every network boundary.
- Pausing narration now preserves and resumes the active audio session instead
  of synthesizing the same text again.
- Unreal Speech API keys now use Obsidian SecretStorage exclusively. Legacy
  plaintext keys migrate once and are removed from normal plugin data. This
  raises the minimum supported Obsidian version to 1.11.4.
- The session narration cache is byte-bounded at 64 MB on desktop and 32 MB on
  mobile. Persistent cache statistics and LRU eviction now use compact metadata
  without loading or rewriting the stored MP3 collection.
- Unreal Speech can use the full 1000 WPM setting through 5x HTML audio playback,
  while System voice keeps its existing 4x safety limit.
- Periodic checkpoint saves are coalesced and less frequent, while pause, close,
  note switch, restart, and completion still persist or clear immediately.
- Narration failures now show a notice while the visual reader continues on its
  estimated clock.

### Fixed

- Clearing narration storage or turning the cache off now clears memory and
  IndexedDB together, and in-flight synthesis cannot repopulate storage afterward.
- Provider text offsets now take precedence over ambiguous spoken-text matching,
  keeping normalized forms such as numbers aligned with the original token.
- Exact-timestamp playback stays frozen during the short seek-restart debounce
  instead of letting the estimated clock skip ahead.
- Changing code-block or frontmatter filtering in an open reader preserves the
  current anchored position rather than resetting to the first word.
- Corrupt or non-finite checkpoint and narration-cache records are rejected before
  they can reach playback or restore logic.

## [0.1.2]

### Fixed

- On phones, the speed bar and transport controls no longer sit underneath
  Obsidian's floating navigation bar; the reader now leaves the same bottom
  clearance Obsidian's own views use.

## [0.1.1]

### Changed

- Code-quality and Obsidian plugin-review compliance: set element styles
  through the Obsidian helper API, use window-scoped globals for popout-window
  compatibility, and drop the build-time `builtin-modules` dependency in favor
  of Node's built-in list. Releases now publish build-provenance attestations.
  No change to reading behavior.

## [0.1.0]

Initial release.

### Added

- RSVP reader view with a fixed-point, Spritz-style optimal-recognition-point display.
- Commands and a ribbon icon to read the current note or the current selection;
  the reader opens in a split beside the note.
- Optional voice narration via the Web Speech API. The audio owns the clock:
  per-word boundary sync where available, per-sentence resync everywhere, the
  display never runs past the sentence being spoken, and the voice is never cut
  off mid-sentence. Speech restarts are minimized and coalesced so rapid
  controls do not churn the system audio engine.
- Follow along in the note: auto-scrolls the source note with the reading and
  keeps the current sentence colored and vertically centered, in editing/Live
  Preview (editor decoration plus typewriter padding) and in Reading view (CSS
  Custom Highlight API plus direct scroller centering). Non-destructive; the
  note's own highlights are unaffected.
- Words auto-fit the reading pane: a long word in a narrow split or on a phone
  scales down to fit instead of being clipped, keeping the anchor letter on the
  center line. Short words show at the configured word size.
- Hold-to-read gesture: press and hold to read while held, release to pause;
  tap to toggle.
- Seekable progress bar (click or drag) with live per-word progress.
- Markdown-aware tokenizer that strips formatting and can skip frontmatter and
  code blocks.
- Punctuation-aware pacing (long words plus clause, sentence, and paragraph pauses).
- Live speed control (100 to 1000 wpm) with a hideable speed bar; speed changes
  apply to the voice on release.
- Keyboard controls: play/pause, step by word or sentence, change speed.
- Settings for speed, word size, follow-in-note, content handling, narration,
  and pacing, applied live to open reader panes.
- Theme-aware styling for light and dark.

[Unreleased]: https://github.com/kevinsslin/obsidian-rsvp-reader/compare/0.2.1...HEAD
[0.2.1]: https://github.com/kevinsslin/obsidian-rsvp-reader/compare/0.2.0...0.2.1
[0.2.0]: https://github.com/kevinsslin/obsidian-rsvp-reader/compare/0.1.2...0.2.0
[0.1.2]: https://github.com/kevinsslin/obsidian-rsvp-reader/compare/0.1.1...0.1.2
[0.1.1]: https://github.com/kevinsslin/obsidian-rsvp-reader/compare/0.1.0...0.1.1
[0.1.0]: https://github.com/kevinsslin/obsidian-rsvp-reader/releases/tag/0.1.0
