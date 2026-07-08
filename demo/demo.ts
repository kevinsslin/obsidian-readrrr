/**
 * Standalone browser demo of the RSVP Reader engine.
 *
 * It imports the exact framework-free modules the Obsidian plugin uses
 * (tokenizer, Reader, Web Speech provider) and wires them to plain DOM, so the
 * RSVP + synced-narration experience can be tried in any browser, including
 * iOS Safari, without installing anything. Bundled to an IIFE and inlined
 * into a single self-contained HTML page.
 */
import { tokenize } from "../src/core/tokenizer";
import { DEFAULT_TIMING } from "../src/core/scheduler";
import { Reader } from "../src/reader/reader";
import { WebSpeechProvider } from "../src/tts/webspeech";
import { wpmToRate } from "../src/tts/rate";

const SAMPLE = `RSVP Reader shows one word at a time at a fixed point on screen, so your eyes never move. One letter is highlighted as the anchor your eye locks onto. This technique is called RSVP, rapid serial visual presentation, and it lets you read much faster than scanning line by line.

Turn on the narrator to hear a voice while you read. The words stay in sync with the voice, so you get both channels at once: your eyes and your ears. Use the speed slider to find your pace, and the arrows to jump between sentences. Press space to play or pause.`;

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
}

function init(): void {
  const beforeEl = $("rr-before");
  const pivotEl = $("rr-pivot");
  const afterEl = $("rr-after");
  const counterEl = $("rr-counter");
  const fillEl = $("rr-fill");
  const playBtn = $("rr-play") as HTMLButtonElement;
  const narrateBtn = $("rr-narrate") as HTMLButtonElement;
  const wpmInput = $("rr-wpm") as HTMLInputElement;
  const wpmVal = $("rr-wpm-val");
  const input = $("rr-input") as HTMLTextAreaElement;
  const stage = $("rr-stage");

  const reader = new Reader();
  const provider = new WebSpeechProvider();
  let narrate = false;
  let wpm = 300;
  let total = 0;

  const timing = () => ({ ...DEFAULT_TIMING, wpm });
  const speak = () => ({ voiceId: null, rate: wpmToRate(wpm), pitch: 1, volume: 1, maxTokensPerChunk: 40 });

  const applyNarration = () => {
    if (narrate && provider.isAvailable()) {
      reader.setNarration({ provider, speak: speak() });
      narrateBtn.classList.add("active");
    } else {
      reader.setNarration(null);
      narrateBtn.classList.remove("active");
    }
  };

  reader.setListeners({
    onWord: (_entry, split) => {
      beforeEl.textContent = split.before;
      pivotEl.textContent = split.pivot;
      afterEl.textContent = split.after;
    },
    onState: (state) => {
      total = state.total;
      playBtn.textContent = state.status === "playing" ? "⏸" : "▶";
      counterEl.textContent = total > 0 ? `${state.index + 1} / ${total}` : "0 / 0";
      fillEl.style.width = total > 0 ? `${((state.index + 1) / total) * 100}%` : "0%";
    },
  });

  const load = (text: string) => {
    reader.load(tokenize(text), timing());
    applyNarration();
  };

  playBtn.addEventListener("click", () => reader.toggle());
  $("rr-restart").addEventListener("click", () => reader.stop());
  $("rr-prev").addEventListener("click", () => reader.seekBySentence(-1));
  $("rr-next").addEventListener("click", () => reader.seekBySentence(1));
  narrateBtn.addEventListener("click", () => {
    narrate = !narrate;
    applyNarration();
  });
  stage.addEventListener("click", () => {
    if (total > 0) reader.toggle();
  });
  wpmInput.addEventListener("input", () => {
    wpm = Number(wpmInput.value);
    wpmVal.textContent = `${wpm} wpm`;
    reader.setTiming(timing());
  });
  $("rr-load").addEventListener("click", () => load(input.value));
  document.addEventListener("keydown", (e) => {
    if (e.key === " " && document.activeElement !== input) {
      e.preventDefault();
      reader.toggle();
    }
  });

  if (!provider.isAvailable()) {
    narrateBtn.style.display = "none";
  }

  input.value = SAMPLE;
  wpmInput.value = String(wpm);
  wpmVal.textContent = `${wpm} wpm`;
  load(SAMPLE);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
