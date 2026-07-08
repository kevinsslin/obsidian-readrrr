/**
 * Time source for the Reader, injectable so playback can be driven
 * deterministically in tests instead of by the wall clock.
 */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(handle: number): void;
}

export const systemClock: Clock = {
  now: () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms) as unknown as number,
  clearTimeout: (handle) =>
    globalThis.clearTimeout(handle as unknown as ReturnType<typeof globalThis.setTimeout>),
};
