import { App, PluginSettingTab, Setting } from "obsidian";
import type RsvpReaderPlugin from "./main";
import { DEFAULT_TIMING, type TimingOptions } from "./core/scheduler";
import type { TokenizeOptions } from "./core/tokenizer";
import { wpmToRate } from "./tts/rate";
import type { SpeakOptions } from "./tts/types";

export interface RsvpReaderSettings {
  wpm: number;
  fontSize: number;
  showWpmBar: boolean;
  followInNote: boolean;
  skipCodeBlocks: boolean;
  skipFrontmatter: boolean;
  longWordThreshold: number;
  extraMsPerChar: number;
  clauseMultiplier: number;
  sentenceMultiplier: number;
  paragraphMultiplier: number;
  minWordMs: number;
  narrate: boolean;
  /** Web Speech voiceURI, or null for the engine default. */
  voiceId: string | null;
  pitch: number;
  volume: number;
}

export const DEFAULT_SETTINGS: RsvpReaderSettings = {
  wpm: 300,
  fontSize: 64,
  showWpmBar: true,
  followInNote: true,
  skipCodeBlocks: true,
  skipFrontmatter: true,
  longWordThreshold: DEFAULT_TIMING.longWordThreshold,
  extraMsPerChar: DEFAULT_TIMING.extraMsPerChar,
  clauseMultiplier: DEFAULT_TIMING.clauseMultiplier,
  sentenceMultiplier: DEFAULT_TIMING.sentenceMultiplier,
  paragraphMultiplier: DEFAULT_TIMING.paragraphMultiplier,
  minWordMs: DEFAULT_TIMING.minWordMs,
  narrate: false,
  voiceId: null,
  pitch: 1,
  volume: 1,
};

export function toTimingOptions(s: RsvpReaderSettings): TimingOptions {
  return {
    wpm: s.wpm,
    longWordThreshold: s.longWordThreshold,
    extraMsPerChar: s.extraMsPerChar,
    clauseMultiplier: s.clauseMultiplier,
    sentenceMultiplier: s.sentenceMultiplier,
    paragraphMultiplier: s.paragraphMultiplier,
    minWordMs: s.minWordMs,
  };
}

export function toTokenizeOptions(s: RsvpReaderSettings): TokenizeOptions {
  return { skipCodeBlocks: s.skipCodeBlocks, skipFrontmatter: s.skipFrontmatter };
}

export function toSpeakOptions(s: RsvpReaderSettings): SpeakOptions {
  return {
    voiceId: s.voiceId,
    rate: wpmToRate(s.wpm),
    pitch: s.pitch,
    volume: s.volume,
    maxTokensPerChunk: 40,
  };
}

const DEFAULT_VOICE_VALUE = "__default__";

export class RsvpReaderSettingTab extends PluginSettingTab {
  private readonly plugin: RsvpReaderPlugin;
  private voicesChangedHandler: (() => void) | null = null;

  constructor(app: App, plugin: RsvpReaderPlugin) {
    super(app, plugin);
    this.plugin = plugin;
    // Ensure the voiceschanged listener is removed if the plugin unloads while
    // this tab is open.
    plugin.register(() => this.removeVoicesListener());
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    const save = async () => {
      // Apply to open reader panes synchronously (within the user gesture, so
      // iOS Web Speech keeps its activation), then persist.
      this.plugin.refreshViews();
      await this.plugin.saveSettings();
    };

    new Setting(containerEl)
      .setName("Reading speed")
      .setDesc("Words per minute.")
      .addSlider((slider) =>
        slider
          .setLimits(100, 1000, 10)
          .setValue(this.plugin.settings.wpm)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.wpm = value;
            await save();
          }),
      );

    new Setting(containerEl)
      .setName("Word size")
      .setDesc("Font size of the flashed word, in pixels.")
      .addSlider((slider) =>
        slider
          .setLimits(24, 140, 2)
          .setValue(this.plugin.settings.fontSize)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.fontSize = value;
            await save();
          }),
      );

    new Setting(containerEl)
      .setName("Show speed bar")
      .setDesc("Show the words-per-minute slider inside the reader.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showWpmBar).onChange(async (value) => {
          this.plugin.settings.showWpmBar = value;
          await save();
        }),
      );

    new Setting(containerEl)
      .setName("Follow along in the note")
      .setDesc("Auto-scroll the note to the current sentence as you read (and highlight it in editing view).")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.followInNote).onChange(async (value) => {
          this.plugin.settings.followInNote = value;
          await save();
        }),
      );

    new Setting(containerEl).setName("Content").setHeading();

    new Setting(containerEl)
      .setName("Skip code blocks")
      .setDesc("Ignore fenced code blocks when reading.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.skipCodeBlocks).onChange(async (value) => {
          this.plugin.settings.skipCodeBlocks = value;
          await save();
        }),
      );

    new Setting(containerEl)
      .setName("Skip frontmatter")
      .setDesc("Ignore the YAML frontmatter block at the top of a note.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.skipFrontmatter).onChange(async (value) => {
          this.plugin.settings.skipFrontmatter = value;
          await save();
        }),
      );

    new Setting(containerEl).setName("Narration").setHeading();

    if (!this.plugin.getProvider()) {
      containerEl.createEl("p", {
        text: "No text-to-speech voice is available in this environment.",
        cls: "setting-item-description",
      });
    } else {
      new Setting(containerEl)
        .setName("Narrate while reading")
        .setDesc("Play a voice in sync with the flashed words.")
        .addToggle((toggle) =>
          toggle.setValue(this.plugin.settings.narrate).onChange(async (value) => {
            this.plugin.settings.narrate = value;
            await save();
          }),
        );

      new Setting(containerEl)
        .setName("Voice")
        .setDesc("System voices load shortly after startup; reopen settings if empty.")
        .addDropdown((dropdown) => {
          dropdown.addOption(DEFAULT_VOICE_VALUE, "System default");
          for (const voice of this.plugin.getProvider()?.listVoices() ?? []) {
            const suffix = voice.localService ? "" : " (network)";
            dropdown.addOption(voice.id, `${voice.label} · ${voice.lang}${suffix}`);
          }
          dropdown.setValue(this.plugin.settings.voiceId ?? DEFAULT_VOICE_VALUE);
          dropdown.onChange(async (value) => {
            this.plugin.settings.voiceId = value === DEFAULT_VOICE_VALUE ? null : value;
            await save();
          });
        });

      new Setting(containerEl)
        .setName("Pitch")
        .addSlider((slider) =>
          slider
            .setLimits(0.5, 2, 0.1)
            .setValue(this.plugin.settings.pitch)
            .setDynamicTooltip()
            .onChange(async (value) => {
              this.plugin.settings.pitch = value;
              await save();
            }),
        );

      new Setting(containerEl)
        .setName("Volume")
        .addSlider((slider) =>
          slider
            .setLimits(0, 1, 0.05)
            .setValue(this.plugin.settings.volume)
            .setDynamicTooltip()
            .onChange(async (value) => {
              this.plugin.settings.volume = value;
              await save();
            }),
        );

      this.registerVoicesChanged();
    }

    new Setting(containerEl).setName("Pacing").setHeading();

    this.addPacingSlider(containerEl, "Long-word threshold", "Word length past which extra time is added.", "longWordThreshold", 4, 16, 1);
    this.addPacingSlider(containerEl, "Extra time per long character (ms)", "", "extraMsPerChar", 0, 60, 2);
    this.addPacingSlider(containerEl, "Clause pause", "Dwell multiplier at commas, semicolons, colons.", "clauseMultiplier", 1, 3, 0.1);
    this.addPacingSlider(containerEl, "Sentence pause", "Dwell multiplier at sentence ends.", "sentenceMultiplier", 1, 4, 0.1);
    this.addPacingSlider(containerEl, "Paragraph pause", "Dwell multiplier at paragraph ends.", "paragraphMultiplier", 1, 5, 0.1);
    this.addPacingSlider(containerEl, "Minimum word time (ms)", "Never show a word for less than this.", "minWordMs", 0, 200, 10);

    new Setting(containerEl).addButton((button) =>
      button.setButtonText("Reset pacing to defaults").onClick(async () => {
        this.plugin.settings.longWordThreshold = DEFAULT_TIMING.longWordThreshold;
        this.plugin.settings.extraMsPerChar = DEFAULT_TIMING.extraMsPerChar;
        this.plugin.settings.clauseMultiplier = DEFAULT_TIMING.clauseMultiplier;
        this.plugin.settings.sentenceMultiplier = DEFAULT_TIMING.sentenceMultiplier;
        this.plugin.settings.paragraphMultiplier = DEFAULT_TIMING.paragraphMultiplier;
        this.plugin.settings.minWordMs = DEFAULT_TIMING.minWordMs;
        await save();
        this.display();
      }),
    );
  }

  hide(): void {
    super.hide();
    this.removeVoicesListener();
  }

  private removeVoicesListener(): void {
    if (this.voicesChangedHandler && typeof window !== "undefined" && window.speechSynthesis) {
      window.speechSynthesis.removeEventListener("voiceschanged", this.voicesChangedHandler);
    }
    this.voicesChangedHandler = null;
  }

  private addPacingSlider(
    containerEl: HTMLElement,
    name: string,
    desc: string,
    key: keyof RsvpReaderSettings,
    min: number,
    max: number,
    step: number,
  ): void {
    const setting = new Setting(containerEl).setName(name);
    if (desc) setting.setDesc(desc);
    setting.addSlider((slider) =>
      slider
        .setLimits(min, max, step)
        .setValue(this.plugin.settings[key] as number)
        .setDynamicTooltip()
        .onChange(async (value) => {
          (this.plugin.settings[key] as number) = value;
          this.plugin.refreshViews();
          await this.plugin.saveSettings();
        }),
    );
  }

  private registerVoicesChanged(): void {
    if (this.voicesChangedHandler || typeof window === "undefined" || !window.speechSynthesis) {
      return;
    }
    this.voicesChangedHandler = () => this.display();
    window.speechSynthesis.addEventListener("voiceschanged", this.voicesChangedHandler);
  }
}
