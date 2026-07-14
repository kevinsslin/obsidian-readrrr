export const DEFAULT_NARRATION_BITRATE_KBPS = 128;
export const DEFAULT_NARRATION_BASE_WPM = 200;

export interface BookStats {
  totalWords: number;
  progress: number;
  remainingWords: number;
  totalReadingMs: number;
  remainingReadingMs: number;
  estimatedNarrationBytes: number;
}

function validWpm(wpm: number): number {
  return Number.isFinite(wpm) && wpm > 0 ? wpm : 300;
}

export function readingDurationMs(words: number, wpm: number): number {
  return (Math.max(0, words) / validWpm(wpm)) * 60_000;
}

export function estimatedNarrationBytes(
  words: number,
  bitrateKbps = DEFAULT_NARRATION_BITRATE_KBPS,
  baseWpm = DEFAULT_NARRATION_BASE_WPM,
): number {
  const seconds = (Math.max(0, words) / validWpm(baseWpm)) * 60;
  return seconds * (Math.max(0, bitrateKbps) * 1_000) / 8;
}

export function calculateBookStats(totalWords: number, index: number, wpm: number): BookStats {
  const total = Math.max(0, Math.floor(totalWords));
  if (total === 0) {
    return {
      totalWords: 0,
      progress: 0,
      remainingWords: 0,
      totalReadingMs: 0,
      remainingReadingMs: 0,
      estimatedNarrationBytes: 0,
    };
  }
  const current = Math.max(0, Math.min(total - 1, Math.round(index)));
  const remainingWords = Math.max(0, total - current - 1);
  return {
    totalWords: total,
    progress: total > 1 ? current / (total - 1) : 1,
    remainingWords,
    totalReadingMs: readingDurationMs(total, wpm),
    remainingReadingMs: readingDurationMs(remainingWords, wpm),
    estimatedNarrationBytes: estimatedNarrationBytes(total),
  };
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0m";
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0 ? `${hours}h` : `${hours}h ${String(remainder).padStart(2, "0")}m`;
}

export function formatBytes(bytes: number): string {
  const value = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
  if (value < 1_000_000) return `${Math.round(value / 1_000)} KB`;
  if (value < 1_000_000_000) {
    const mb = value / 1_000_000;
    return `${mb < 100 ? mb.toFixed(1) : Math.round(mb)} MB`;
  }
  const gb = value / 1_000_000_000;
  return `${gb.toFixed(gb < 10 ? 1 : 0)} GB`;
}
