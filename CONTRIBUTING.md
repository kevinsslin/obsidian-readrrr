# Contributing

Thanks for your interest in RSVP Reader. This is a small, focused plugin and
contributions are welcome.

## Setup

```bash
npm install
npm run check   # lint + typecheck + tests + build; run this before a PR
```

Useful scripts: `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`,
`npm run dev` (watch), `npm run build:demo`.

## Guidelines

- **Keep the engine free of Obsidian imports.** Everything under `src/core`,
  `src/tts`, and `src/reader` must not import from `obsidian`, so it stays
  unit-testable and reusable. Obsidian-specific code lives in `src/main.ts`,
  `src/settings.ts`, and `src/ui`.
- **Add tests.** Pure logic gets vitest coverage. The reader is tested with an
  injectable clock and a fake TTS provider, so behavior is deterministic.
- **Conventional commits.** Use `feat:`, `fix:`, `docs:`, `chore:`, etc.
- Match the surrounding code style; `eslint` and `tsc` must pass.

## Testing in Obsidian

Build the plugin (`npm run build`) and copy `main.js`, `manifest.json`, and
`styles.css` into a test vault under `.obsidian/plugins/rsvp-reader/`, then
enable it. See [`docs/manual-qa.md`](docs/manual-qa.md) for a checklist.

## Releasing

1. Bump the version: `npm version <patch|minor|major>` (this updates
   `manifest.json` and `versions.json` via the `version` script).
2. Push the tag: `git push --follow-tags`.
3. The release workflow builds and attaches `main.js`, `manifest.json`, and
   `styles.css` to a GitHub release named after the version.
