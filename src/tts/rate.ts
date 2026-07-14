/** Clamp a number into [min, max]. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Map a reading speed in WPM to a Web Speech `rate` value. The Web Speech
 * scale is engine-relative (1 = the engine's normal pace, roughly 200 wpm), so
 * this is an approximation; the display resyncs to audio at each sentence end
 * regardless, so exact calibration is not critical.
 */
export function wpmToRate(wpm: number): number {
  return clamp(wpm / 200, 0.5, 4);
}

/** Map WPM to HTML audio playbackRate, which supports the full 1000 WPM UI range. */
export function wpmToTimedAudioRate(wpm: number): number {
  return clamp(wpm / 200, 0.5, 5);
}
