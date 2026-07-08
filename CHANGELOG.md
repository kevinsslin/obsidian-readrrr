# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/kevinsslin/obsidian-rsvp-reader/compare/0.1.1...HEAD
[0.1.1]: https://github.com/kevinsslin/obsidian-rsvp-reader/compare/0.1.0...0.1.1
[0.1.0]: https://github.com/kevinsslin/obsidian-rsvp-reader/releases/tag/0.1.0
