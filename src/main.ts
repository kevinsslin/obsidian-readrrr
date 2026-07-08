import { MarkdownView, Notice, Plugin, type TFile } from "obsidian";
import { noteHighlightField } from "./ui/note-highlight";
import { RsvpView, VIEW_TYPE_RSVP_READER } from "./ui/rsvp-view";
import {
  DEFAULT_SETTINGS,
  RsvpReaderSettingTab,
  type RsvpReaderSettings,
} from "./settings";
import { WebSpeechProvider } from "./tts/webspeech";
import type { TtsProvider } from "./tts/types";

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
  private provider: TtsProvider | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    const webSpeech = new WebSpeechProvider();
    this.provider = webSpeech.isAvailable() ? webSpeech : null;

    this.registerView(VIEW_TYPE_RSVP_READER, (leaf) => new RsvpView(leaf, this));
    this.registerEditorExtension(noteHighlightField);

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
  }

  getProvider(): TtsProvider | null {
    return this.provider;
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as Partial<RsvpReaderSettings> | null;
    const legacy = data as { followInNote?: unknown; highlightInNote?: unknown } | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data ?? {});
    if (
      typeof legacy?.followInNote !== "boolean" &&
      typeof legacy?.highlightInNote === "boolean"
    ) {
      this.settings.followInNote = legacy.highlightInNote;
    }
    delete (this.settings as RsvpReaderSettings & { highlightInNote?: boolean }).highlightInNote;
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
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
