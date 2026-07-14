# Manual QA checklist

Automated coverage handles the engine (unit and integration tests), the shipped
bundle (a load smoke test), and the engine in a real browser (the demo). This
checklist covers the parts that need a human in Obsidian.

## Setup

1. Use Obsidian 1.11.4 or newer, then run `npm run build` to produce `main.js`.
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
- [ ] The book stats line shows word count, progress, remaining time at the current
      WPM, and the estimated narration size when Unreal Speech is selected.
- [ ] Pause partway through a note, close the reader pane, reopen the same note,
      and confirm it resumes at the checkpoint with one concise notice.
- [ ] Insert text before a saved checkpoint and reopen; nearby token anchors should
      restore the same passage rather than the old numeric word index.
- [ ] Renaming the source note preserves its checkpoint; deleting it removes the
      checkpoint. Restart and completed playback both clear the saved position.
- [ ] Selection-only reading does not create a per-note checkpoint.
- [ ] While positioned partway through a note, toggle Skip code blocks or Skip
      frontmatter. The reader should stay at the same anchored passage and retain
      its playing or paused state instead of resetting to the first word.
- [ ] Dragging the speed bar changes the pace immediately; hiding it in settings works.
- [ ] With **System voice** selected, turning on Voice narrates in sync; the
      display tracks word boundaries where available and resyncs each sentence.
- [ ] With **Unreal Speech** selected and a valid API key, the first play waits
      briefly for its startup buffer, then the selected voice starts and every
      displayed word follows the spoken-word timestamps (including repeated
      words, normalized numbers, and punctuation).
- [ ] Confirm the API key is present in Obsidian SecretStorage and absent from the
      plugin's `data.json`, including after migrating from a pre-0.2.0 install.
- [ ] On a long note containing many short sentences, test 500 and 1000 WPM.
      Playback should remain continuous across chunk boundaries after the initial
      buffer instead of repeatedly stopping to wait for the network.
- [ ] After generating a passage, reload the plugin and replay it with the same
      voice and pitch. IndexedDB should serve it without another `/speech` call.
      Changing only WPM or volume should still hit the cache; changing voice or
      pitch should generate a new entry.
- [ ] Narration Cache settings show exact usage and entry count. Test each limit,
      verify least-recently-used eviction, confirm Off clears storage, and confirm
      the warning modal before **Clear cache** deletes device-local entries.
- [ ] Press **Clear cache** while a synthesis request is still in flight. Active
      playback may finish, but cache usage must remain at zero after the request
      resolves. Replaying the passage should make a fresh request.
- [ ] An invalid Unreal Speech key shows one useful error notice; visual reading
      continues silently instead of hanging at a sentence boundary.
- [ ] Pausing and resuming Unreal Speech continues the current audio without a
      fresh synthesis request. Also try a quick pause/resume before the first
      audio arrives. Seeking while paused restarts at the sought word.
- [ ] While Unreal Speech is playing, make several rapid word seeks. The display
      stays on the final sought word during the restart debounce, then advances
      only when replacement audio timestamps arrive.
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
- [ ] On a phone, the speed bar and controls sit fully above Obsidian's
      floating navigation bar (nothing hides behind it). Check both the
      floating and classic navigation bar styles, and on Android also with the
      keyboard open and closed.
- [ ] Narration starts when triggered by a tap (the play button or Voice toggle).
- [ ] Word or sentence sync is acceptable with an on-device voice.
- [ ] Unreal Speech can synthesize and play through `requestUrl`; its word sync,
      pause/resume, voice selection, and error notice match desktop behavior.
- [ ] IndexedDB audio survives closing and reopening Obsidian on the device, obeys
      the mobile cache limit, and never creates MP3 files inside the vault.
- [ ] If plugin settings sync between devices, note checkpoints resume on the
      second device while narration audio remains local to each device.
- [ ] Locking the phone or switching apps records whether Unreal Speech audio
      continues; background playback depends on Obsidian's iOS host capability.
