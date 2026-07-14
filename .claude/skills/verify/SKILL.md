---
name: verify
summary: Launch RSVP Reader in an isolated Obsidian profile and drive it over CDP.
---

# Verify RSVP Reader in Obsidian

1. Run `npm run build` so `main.js` matches the source.
2. Create a temporary vault with `.obsidian/plugins/rsvp-reader/`, copy
   `main.js`, `manifest.json`, and `styles.css`, and enable `rsvp-reader` in
   `.obsidian/community-plugins.json`.
3. Create an isolated Electron profile whose `obsidian.json` registers that
   vault, then launch:

   ```sh
   /Applications/Obsidian.app/Contents/MacOS/Obsidian \
     --user-data-dir=<temp-profile> \
     --remote-debugging-port=9223 \
     --disable-gpu
   ```

4. Connect to the page from `http://127.0.0.1:9223/json/list` using Chrome
   DevTools Protocol. Turn off Restricted Mode in the UI (or call
   `app.plugins.setEnable(true)` in this disposable profile), click the vault
   note and RSVP Reader ribbon button, then drive settings and reader controls
   through DOM clicks/events. Use `Page.captureScreenshot` for visible evidence.
5. Check the browser console/notices, reader word/counter/status, provider
   dropdown, masked key field, and voice list. For cloud narration, use a real
   API key only with user authorization; otherwise verify fallback and 401
   handling, and inject a fake provider service into the running plugin to
   exercise timestamp playback, pause/resume, prefetch, caching, and seek.
6. Stop the isolated Obsidian process and remove its temporary profile/vault.

Mobile/background audio still requires an iPhone or iPad manual pass from
`docs/manual-qa.md`.
