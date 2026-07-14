import {
  App,
  Modal,
  Notice,
  PluginSettingTab,
  Setting,
  type DropdownComponent,
} from "obsidian";
import type RsvpReaderPlugin from "./main";
import { DEFAULT_TIMING, type TimingOptions } from "./core/scheduler";
import type { TokenizeOptions } from "./core/tokenizer";
import { wpmToRate, wpmToTimedAudioRate } from "./tts/rate";
import type { SpeakOptions } from "./tts/types";
import { formatBytes } from "./book-stats";

export interface RsvpReaderSettings {
  wpm: number;
  fontSize: number;
  showWpmBar: boolean;
  followInNote: boolean;
  resumeReadingPosition: boolean;
  skipCodeBlocks: boolean;
  skipFrontmatter: boolean;
  longWordThreshold: number;
  extraMsPerChar: number;
  clauseMultiplier: number;
  sentenceMultiplier: number;
  paragraphMultiplier: number;
  minWordMs: number;
  narrate: boolean;
  /** Which TTS provider narrates ("web-speech" or "unreal-speech"). */
  ttsProvider: string;
  /** Web Speech voiceURI, or null for the engine default. */
  voiceId: string | null;
  /** Unreal Speech voice, or null for the default. */
  unrealVoiceId: string | null;
  pitch: number;
  volume: number;
}

export const DEFAULT_SETTINGS: RsvpReaderSettings = {
  wpm: 300,
  fontSize: 64,
  showWpmBar: true,
  followInNote: true,
  resumeReadingPosition: true,
  skipCodeBlocks: true,
  skipFrontmatter: true,
  longWordThreshold: DEFAULT_TIMING.longWordThreshold,
  extraMsPerChar: DEFAULT_TIMING.extraMsPerChar,
  clauseMultiplier: DEFAULT_TIMING.clauseMultiplier,
  sentenceMultiplier: DEFAULT_TIMING.sentenceMultiplier,
  paragraphMultiplier: DEFAULT_TIMING.paragraphMultiplier,
  minWordMs: DEFAULT_TIMING.minWordMs,
  narrate: false,
  ttsProvider: "web-speech",
  voiceId: null,
  unrealVoiceId: null,
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

export function toSpeakOptions(
  s: RsvpReaderSettings,
  providerId = s.ttsProvider,
): SpeakOptions {
  return {
    voiceId: providerId === "unreal-speech" ? s.unrealVoiceId : s.voiceId,
    rate: providerId === "unreal-speech" ? wpmToTimedAudioRate(s.wpm) : wpmToRate(s.wpm),
    pitch: s.pitch,
    volume: s.volume,
    maxTokensPerChunk: 40,
  };
}

const DEFAULT_VOICE_VALUE = "__default__";
const CACHE_LIMITS = [
  { value: 0, label: "Off" },
  { value: 250_000_000, label: "250 MB" },
  { value: 500_000_000, label: "500 MB" },
  { value: 1_000_000_000, label: "1 GB" },
  { value: 2_000_000_000, label: "2 GB" },
];

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

    new Setting(containerEl)
      .setName("Resume reading position")
      .setDesc("Remember a checkpoint for each note and continue from it next time.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.resumeReadingPosition).onChange(async (value) => {
          this.plugin.settings.resumeReadingPosition = value;
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

    {
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
        .setName("Voice provider")
        .setDesc(
          "System voice is free and uses your device (choose an on-device voice for offline use). Unreal Speech is the natural-sounding engine behind Readwise Reader; it needs your own API key (free tier: 250K characters).",
        )
        .addDropdown((dropdown) => {
          dropdown.addOption("web-speech", "System voice (free)");
          dropdown.addOption("unreal-speech", "Unreal Speech (API key)");
          dropdown.setValue(this.plugin.settings.ttsProvider);
          dropdown.onChange(async (value) => {
            this.plugin.settings.ttsProvider = value;
            await save();
            this.display(); // re-render the provider-specific controls below
          });
        });

      if (this.plugin.settings.ttsProvider === "unreal-speech") {
        this.displayUnrealSettings(containerEl, save);
      } else {
        this.displayWebSpeechSettings(containerEl, save);
      }

      const maxPitch = this.plugin.settings.ttsProvider === "unreal-speech" ? 1.5 : 2;
      new Setting(containerEl)
        .setName("Pitch")
        .addSlider((slider) =>
          slider
            .setLimits(0.5, maxPitch, 0.1)
            .setValue(Math.min(this.plugin.settings.pitch, maxPitch))
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
            .onChange(async (value) => {
              this.plugin.settings.volume = value;
              await save();
            }),
        );
    }

    this.displayNarrationCacheSettings(containerEl);

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

  private displayNarrationCacheSettings(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("Narration cache").setHeading();
    const usage = new Setting(containerEl)
      .setName("Device-local audio")
      .setDesc("Loading cache usage…");
    let limitDropdown: DropdownComponent | null = null;

    const refresh = async (): Promise<void> => {
      try {
        const stats = await this.plugin.getNarrationCacheStats();
        if (!stats) {
          usage.setDesc("Persistent audio storage is unavailable in this environment.");
          return;
        }
        usage.setDesc(
          `${formatBytes(stats.totalBytes)} used across ${stats.entries.toLocaleString()} chunks. Audio stays on this device and is not stored in the vault.`,
        );
        limitDropdown?.setValue(String(stats.limitBytes));
      } catch {
        usage.setDesc("Could not read the device-local narration cache.");
      }
    };

    new Setting(containerEl)
      .setName("Cache limit")
      .setDesc("Old persistent audio is removed least-recently-used first. Turning this off clears persistent and memory caches.")
      .addDropdown((dropdown) => {
        limitDropdown = dropdown;
        for (const option of CACHE_LIMITS) {
          dropdown.addOption(String(option.value), option.label);
        }
        dropdown.onChange(async (value) => {
          await this.plugin.setNarrationCacheLimitBytes(Number(value));
          await refresh();
        });
      });

    new Setting(containerEl)
      .setName("Clear narration cache")
      .setDesc("Delete downloaded MP3 audio and word timings from persistent and memory caches on this device.")
      .addButton((button) =>
        button.setButtonText("Clear cache").setWarning().onClick(() => {
          new ClearNarrationCacheModal(this.app, async () => {
            await this.plugin.clearNarrationCache();
            new Notice("RSVP Reader: narration cache cleared.");
            await refresh();
          }).open();
        }),
      );

    void refresh();
  }

  /** System (Web Speech) voice picker, only rendered for that provider. */
  private displayWebSpeechSettings(containerEl: HTMLElement, save: () => Promise<void>): void {
    const provider = this.plugin.getProviderById("web-speech");
    if (!provider?.isAvailable()) {
      containerEl.createEl("p", {
        text: "No system text-to-speech voice is available in this environment.",
        cls: "setting-item-description",
      });
      return;
    }

    new Setting(containerEl)
      .setName("Voice")
      .setDesc("System voices load shortly after startup; reopen settings if empty.")
      .addDropdown((dropdown) => {
        dropdown.addOption(DEFAULT_VOICE_VALUE, "System default");
        for (const voice of provider.listVoices()) {
          const suffix = voice.localService ? "" : " (network)";
          dropdown.addOption(voice.id, `${voice.label} · ${voice.lang}${suffix}`);
        }
        dropdown.setValue(this.plugin.settings.voiceId ?? DEFAULT_VOICE_VALUE);
        dropdown.onChange(async (value) => {
          this.plugin.settings.voiceId = value === DEFAULT_VOICE_VALUE ? null : value;
          await save();
        });
      });

    this.registerVoicesChanged();
  }

  /** Unreal Speech key + voice picker, only rendered for that provider. */
  private displayUnrealSettings(containerEl: HTMLElement, save: () => Promise<void>): void {
    new Setting(containerEl)
      .setName("Unreal Speech API key")
      .setDesc(
        createFragment((frag) => {
          frag.appendText("Get a key at ");
          frag.createEl("a", { text: "unrealspeech.com", href: "https://unrealspeech.com" });
          frag.appendText(
            ". Usage is billed to your key per character. Obsidian keeps the key in SecretStorage, while generated audio uses bounded memory and device-local caches to reduce repeat charges. Without a key, narration falls back to an available system voice.",
          );
        }),
      )
      .addText((text) => {
        text.inputEl.type = "password";
        text.inputEl.autocomplete = "off";
        text
          .setPlaceholder("api key")
          .setValue(this.plugin.getUnrealApiKey())
          .onChange(async (value) => {
            // Persist each edit, but do not restart live narration on every
            // keystroke with an incomplete key. Apply once the field commits.
            this.plugin.setUnrealApiKey(value.trim());
            await this.plugin.saveSettings();
          });
        text.inputEl.addEventListener("change", () => this.plugin.refreshViews());
      });

    const provider = this.plugin.getProviderById("unreal-speech");
    new Setting(containerEl).setName("Voice").addDropdown((dropdown) => {
      for (const voice of provider?.listVoices() ?? []) {
        dropdown.addOption(voice.id, voice.label);
      }
      const fallback = provider?.listVoices()[0]?.id ?? "";
      dropdown.setValue(this.plugin.settings.unrealVoiceId ?? fallback);
      dropdown.onChange(async (value) => {
        this.plugin.settings.unrealVoiceId = value;
        await save();
      });
    });
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

class ClearNarrationCacheModal extends Modal {
  private readonly confirm: () => Promise<void>;

  constructor(app: App, confirm: () => Promise<void>) {
    super(app);
    this.confirm = confirm;
  }

  onOpen(): void {
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: "Clear narration cache?" });
    this.contentEl.createEl("p", {
      text: "Downloaded narration in persistent and memory caches on this device will be deleted. Replaying uncached text may use API characters again.",
    });
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((button) =>
        button.setButtonText("Clear cache").setWarning().onClick(async () => {
          button.setDisabled(true);
          try {
            await this.confirm();
            this.close();
          } catch {
            button.setDisabled(false);
            new Notice("RSVP Reader: could not clear the narration cache.");
          }
        }),
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
