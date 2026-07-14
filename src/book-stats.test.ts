import { describe, expect, it } from "vitest";
import {
  calculateBookStats,
  estimatedNarrationBytes,
  formatBytes,
  formatDuration,
  readingDurationMs,
} from "./book-stats";

describe("book statistics", () => {
  it.each([
    [40_000, 200, 200 * 60_000, 192_000_000],
    [80_000, 500, 160 * 60_000, 384_000_000],
    [100_000, 1_000, 100 * 60_000, 480_000_000],
    [150_000, 300, 500 * 60_000, 720_000_000],
  ])("estimates %i words at %i WPM", (words, wpm, duration, bytes) => {
    expect(readingDurationMs(words, wpm)).toBe(duration);
    expect(estimatedNarrationBytes(words)).toBe(bytes);
  });

  it("calculates progress and remaining reading time", () => {
    const stats = calculateBookStats(101, 25, 300);
    expect(stats.progress).toBe(0.25);
    expect(stats.remainingWords).toBe(75);
    expect(stats.remainingReadingMs).toBe(15_000);
  });

  it("formats durations for compact reader display", () => {
    expect(formatDuration(0)).toBe("0m");
    expect(formatDuration(30_000)).toBe("1m");
    expect(formatDuration(59 * 60_000)).toBe("59m");
    expect(formatDuration(60 * 60_000)).toBe("1h");
    expect(formatDuration(126 * 60_000)).toBe("2h 06m");
  });

  it("formats decimal storage sizes", () => {
    expect(formatBytes(480_000)).toBe("480 KB");
    expect(formatBytes(9_600_000)).toBe("9.6 MB");
    expect(formatBytes(480_000_000)).toBe("480 MB");
    expect(formatBytes(1_500_000_000)).toBe("1.5 GB");
  });
});
