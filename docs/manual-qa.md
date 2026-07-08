# Manual QA checklist

Automated coverage handles the engine (unit and integration tests), the shipped
bundle (a load smoke test), and the engine in a real browser (the demo). This
checklist covers the parts that need a human in Obsidian.

## Setup

1. `npm run build` to produce `main.js`.
2. Copy `main.js`, `manifest.json`, `styles.css` into
   `<test vault>/.obsidian/plugins/rsvp-reader/`.
3. Enable **RSVP Reader** in Settings → Community plugins.

## Desktop

- [ ] The gauge ribbon icon appears; clicking it opens the reader on the active note.
- [ ] **RSVP Reader: read current note** and **read selection** both work.
- [ ] Reading an empty note or a non-markdown file shows a notice, not an error.
- [ ] Words flash one at a time; the anchor letter stays in a fixed column.
- [ ] Markdown is stripped (no `#`, `**`, list markers, or link syntax shown);
      frontmatter and fenced code blocks are skipped.
- [ ] Space plays and pauses; clicking the word pauses.
- [ ] Left/Right step by word; Shift+Left/Right jump by sentence; Up/Down change speed.
- [ ] The progress bar and the counter track position.
- [ ] Dragging the speed bar changes the pace immediately; hiding it in settings works.
- [ ] Turning on Voice narrates in sync; the display tracks the voice and
      resyncs each sentence.
- [ ] With Voice on, the last sentence is always spoken to the end (never cut off).
- [ ] Follow in note (file button): the note scrolls with the reading, and the
      current sentence is colored and vertically centered, in both Live Preview
      and Reading view.
- [ ] A note containing `==existing highlights==` keeps them intact and visibly
      distinct from the moving follow highlight.
- [ ] Press-and-hold the word reads while held and pauses on release; a quick
      tap toggles play/pause.
- [ ] Dragging the progress bar scrubs; releasing resumes from that spot.
- [ ] Changing a setting updates an already-open reader pane.
- [ ] Switching the Obsidian theme (light/dark) restyles the reader.
- [ ] Closing the pane and reloading the plugin leaves no lingering audio or errors
      (check the developer console).

## Mobile (iPhone / iPad)

- [ ] The plugin loads on Obsidian mobile.
- [ ] The reader displays and the controls are tappable at a comfortable size.
- [ ] Narration starts when triggered by a tap (the play button or Voice toggle).
- [ ] Word or sentence sync is acceptable with an on-device voice.
