import { MarkdownView, Notice, Platform, Plugin, requestUrl, TFile } from "obsidian";
import { noteHighlightExtensions } from "./ui/note-highlight";
import { RsvpView, VIEW_TYPE_RSVP_READER } from "./ui/rsvp-view";
import {
  DEFAULT_SETTINGS,
  RsvpReaderSettingTab,
  SOURCE_PANE_MODES,
  type RsvpReaderSettings,
} from "./settings";
import { WebSpeechProvider } from "./tts/webspeech";
import { UnrealSpeechProvider, type UnrealHttp } from "./tts/unreal";
import type { TtsProvider } from "./tts/types";
import {
  IndexedDbNarrationCache,
  requestPersistentStorage,
  type NarrationCacheStats,
} from "./tts/persistent-cache";
import {
  isReadingCheckpoint,
  type ReadingCheckpoint,
} from "./checkpoints";
import { LatestSave } from "./latest-save";

const UNREAL_API_KEY_SECRET = "rsvp-reader-unreal-api-key";

type OptionalSecretStorage = {
  getSecret(id: string): string | null;
  setSecret(id: string, secret: string): void;
};

interface PersistedPluginData extends Partial<RsvpReaderSettings> {
  /** Read only for migration from releases before 0.2.0. */
  unrealApiKey?: unknown;
  checkpoints?: Record<string, unknown>;
  cacheNamespace?: string;
}

const MAX_CHECKPOINTS = 500;
const MEGABYTE = 1_000_000;
const MOBILE_MEMORY_CACHE_BYTES = 32 * MEGABYTE;
const DESKTOP_MEMORY_CACHE_BYTES = 64 * MEGABYTE;

/** Unreal Speech HTTP via Obsidian's requestUrl (no CORS, works on mobile). */
const unrealHttp: UnrealHttp = {
  postJson: async (url, headers, body) =>
    (await requestUrl({ url, method: "POST", headers, body: JSON.stringify(body) })).json as unknown,
  getJson: async (url) => (await requestUrl({ url })).json as unknown,
  getBinary: async (url) => (await requestUrl({ url })).arrayBuffer,
};

/**
 * RSVP Reader: RSVP speed reading for Obsidian.
 *
 * The reading engine (tokenizer, ORP, scheduler) and TTS providers live in
 * `src/core`, `src/tts`, and `src/reader` and are free of any `obsidian`
 * imports so they can be unit-tested in isolation. This file is the thin
 * Obsidian-facing shell that wires them into a view, commands, and settings.
 */
export default class RsvpReaderPlugin extends Plugin {
  settings: RsvpReaderSettings = DEFAULT_SETTINGS;
  private providers: TtsProvider[] = [];
  private checkpoints: Record<string, ReadingCheckpoint> = {};
  private cacheNamespace = "";
  private narrationCache: IndexedDbNarrationCache | null = null;
  private unrealProvider: UnrealSpeechProvider | null = null;
  private sessionUnrealApiKey = "";
  private readonly dataSaver = new LatestSave<PersistedPluginData>((payload) =>
    this.saveData(payload),
  );

  async onload(): Promise<void> {
    await this.loadSettings();
    this.initializeNarrationCache();

    this.unrealProvider = new UnrealSpeechProvider(
      () => ({ apiKey: this.getUnrealApiKey() }),
      unrealHttp,
      {},
      this.narrationCache,
      Platform.isMobile ? MOBILE_MEMORY_CACHE_BYTES : DESKTOP_MEMORY_CACHE_BYTES,
    );
    this.providers = [new WebSpeechProvider(), this.unrealProvider];

    this.registerView(VIEW_TYPE_RSVP_READER, (leaf) => new RsvpView(leaf, this));
    this.registerEditorExtension(noteHighlightExtensions);

    this.addRibbonIcon("gauge", "RSVP Reader: read current note", () => {
      void this.readCurrentNote();
    });

    this.addCommand({
      id: "read-current-note",
      name: "Read current note",
      callback: () => void this.readCurrentNote(),
    });

    this.addCommand({
      id: "read-selection",
      name: "Read selection",
      editorCallback: (editor) => {
        const selection = editor.getSelection();
        void this.startReading(selection, this.activeTitle() ?? "Selection", null);
      },
    });

    this.addCommand({
      id: "open-reader",
      name: "Open reader pane",
      callback: () => void this.activateView(),
    });

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (file instanceof TFile) this.moveCheckpoint(oldPath, file.path);
      }),
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (file instanceof TFile) this.clearCheckpoint(file.path);
      }),
    );

    this.addSettingTab(new RsvpReaderSettingTab(this.app, this));
  }

  onunload(): void {
    // Per Obsidian's guidelines, do NOT detach leaves here (that would disrupt
    // the user's layout on every plugin update). Just release each open
    // reader's timers and audio; Obsidian manages the leaves themselves.
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_RSVP_READER)) {
      const view = leaf.view;
      if (view instanceof RsvpView) view.dispose();
    }
    this.unrealProvider?.clearCache();
    this.unrealProvider = null;
    this.narrationCache?.close();
  }

  /** The provider selected in settings, falling back to the free system voice. */
  getProvider(): TtsProvider | null {
    const selected = this.getProviderById(this.settings.ttsProvider);
    if (selected?.isAvailable()) return selected;
    const system = this.getProviderById("web-speech");
    return system?.isAvailable() ? system : null;
  }

  /** A provider definition, even when it still needs configuration (e.g. a key). */
  getProviderById(id: string): TtsProvider | null {
    return this.providers.find((p) => p.id === id) ?? null;
  }

  async loadSettings(): Promise<void> {
    const data = ((await this.loadData()) as PersistedPluginData | null) ?? {};
    const { checkpoints, cacheNamespace, unrealApiKey, ...settingsData } = data;
    const legacy = settingsData as { followInNote?: unknown; highlightInNote?: unknown };
    this.settings = Object.assign({}, DEFAULT_SETTINGS, settingsData);
    if (
      typeof legacy.followInNote !== "boolean" &&
      typeof legacy.highlightInNote === "boolean"
    ) {
      this.settings.followInNote = legacy.highlightInNote;
    }
    delete (this.settings as RsvpReaderSettings & { highlightInNote?: boolean }).highlightInNote;
    if (!["web-speech", "unreal-speech"].includes(this.settings.ttsProvider)) {
      this.settings.ttsProvider = DEFAULT_SETTINGS.ttsProvider;
    }
    if (!SOURCE_PANE_MODES.includes(this.settings.sourcePaneMode)) {
      this.settings.sourcePaneMode = DEFAULT_SETTINGS.sourcePaneMode;
    }
    if (typeof this.settings.unrealVoiceId !== "string") this.settings.unrealVoiceId = null;

    this.checkpoints = {};
    for (const [path, value] of Object.entries(checkpoints ?? {})) {
      if (isReadingCheckpoint(value)) this.checkpoints[path] = { ...value, filePath: path };
    }
    this.cacheNamespace =
      typeof cacheNamespace === "string" && cacheNamespace
        ? cacheNamespace
        : this.createCacheNamespace();
    let needsSave = this.cacheNamespace !== cacheNamespace;

    // Move the pre-0.2.0 plaintext field into SecretStorage, then scrub it from
    // every future plugin-data snapshot. The fallback lasts only this session if
    // SecretStorage is unexpectedly absent or unavailable.
    if (unrealApiKey !== undefined) {
      needsSave = true;
      if (typeof unrealApiKey === "string" && unrealApiKey.trim()) {
        const key = unrealApiKey.trim();
        this.sessionUnrealApiKey = key;
        const secrets = this.secretStorage();
        try {
          if (secrets && !secrets.getSecret(UNREAL_API_KEY_SECRET)) {
            secrets.setSecret(UNREAL_API_KEY_SECRET, key);
          }
        } catch {
          // Keep the migrated key in memory only for this plugin session.
        }
      }
    }
    if (needsSave) await this.persistData();
  }

  getUnrealApiKey(): string {
    try {
      return this.secretStorage()?.getSecret(UNREAL_API_KEY_SECRET) ?? this.sessionUnrealApiKey;
    } catch {
      return this.sessionUnrealApiKey;
    }
  }

  setUnrealApiKey(value: string): void {
    this.sessionUnrealApiKey = value;
    try {
      this.secretStorage()?.setSecret(UNREAL_API_KEY_SECRET, value);
    } catch {
      // SecretStorage is required by the manifest, but never fall back to disk.
    }
  }

  private secretStorage(): OptionalSecretStorage | null {
    return (
      (this.app as unknown as { secretStorage?: OptionalSecretStorage }).secretStorage ?? null
    );
  }

  async saveSettings(): Promise<void> {
    await this.persistData();
  }

  private initializeNarrationCache(): void {
    if (!globalThis.indexedDB) return;
    try {
      const defaultLimit = (Platform.isMobile ? 500 : 1_000) * MEGABYTE;
      this.narrationCache = new IndexedDbNarrationCache(
        this.cacheNamespace,
        defaultLimit,
      );
      void requestPersistentStorage();
    } catch {
      this.narrationCache = null;
    }
  }

  getCacheNamespace(): string {
    return this.cacheNamespace;
  }

  async getNarrationCacheStats(): Promise<NarrationCacheStats | null> {
    return this.narrationCache ? this.narrationCache.getStats() : null;
  }

  async setNarrationCacheLimitBytes(limitBytes: number): Promise<void> {
    if (limitBytes <= 0) this.unrealProvider?.clearCache();
    await this.narrationCache?.setLimitBytes(limitBytes);
  }

  async clearNarrationCache(): Promise<void> {
    this.unrealProvider?.clearCache();
    await this.narrationCache?.clear();
  }

  getCheckpoint(path: string): ReadingCheckpoint | null {
    return this.checkpoints[path] ?? null;
  }

  setCheckpoint(checkpoint: ReadingCheckpoint): void {
    this.checkpoints[checkpoint.filePath] = checkpoint;
    const entries = Object.values(this.checkpoints);
    if (entries.length > MAX_CHECKPOINTS) {
      entries
        .sort((a, b) => a.updatedAt - b.updatedAt)
        .slice(0, entries.length - MAX_CHECKPOINTS)
        .forEach((oldest) => delete this.checkpoints[oldest.filePath]);
    }
    void this.persistData();
  }

  clearCheckpoint(path: string): void {
    if (!this.checkpoints[path]) return;
    delete this.checkpoints[path];
    void this.persistData();
  }

  private moveCheckpoint(oldPath: string, newPath: string): void {
    const checkpoint = this.checkpoints[oldPath];
    if (!checkpoint) return;
    delete this.checkpoints[oldPath];
    this.checkpoints[newPath] = { ...checkpoint, filePath: newPath };
    void this.persistData();
  }

  private createCacheNamespace(): string {
    return globalThis.crypto?.randomUUID?.() ??
      `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }

  private persistData(): Promise<void> {
    const safeSettings = { ...this.settings } as Record<string, unknown>;
    delete safeSettings.unrealApiKey;
    const payload: PersistedPluginData = {
      ...safeSettings,
      checkpoints: { ...this.checkpoints },
      cacheNamespace: this.cacheNamespace,
    };
    return this.dataSaver.enqueue(payload);
  }

  /** Re-apply settings to every open reader pane. */
  refreshViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_RSVP_READER)) {
      const view = leaf.view;
      if (view instanceof RsvpView) view.applySettings();
    }
  }

  private activeTitle(): string | null {
    return this.app.workspace.getActiveFile()?.basename ?? null;
  }

  private async readCurrentNote(): Promise<void> {
    const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
    let text = "";
    let title = "Untitled";
    let file: TFile | null = null;

    if (markdownView?.file) {
      file = markdownView.file;
      title = file.basename;
      text = markdownView.editor?.getValue() ?? (await this.app.vault.read(file));
    } else {
      // Only read plain markdown notes; ignore canvas/PDF/image/other files.
      const active = this.app.workspace.getActiveFile();
      if (active && active.extension === "md") {
        file = active;
        title = active.basename;
        text = await this.app.vault.read(active);
      }
    }

    await this.startReading(text, title, file);
  }

  private async startReading(text: string, title: string, file: TFile | null): Promise<void> {
    if (!text || !text.trim()) {
      new Notice("RSVP Reader: nothing to read.");
      return;
    }
    const view = await this.activateView();
    view.setContent(text, title, file);
  }

  private async activateView(): Promise<RsvpView> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_RSVP_READER)[0];
    if (!leaf) {
      // Open beside the current note: the article stays on the left, the reader
      // opens on the right.
      leaf = workspace.getLeaf("split", "vertical");
      await leaf.setViewState({ type: VIEW_TYPE_RSVP_READER, active: true });
    }
    await workspace.revealLeaf(leaf);
    return leaf.view as RsvpView;
  }
}
