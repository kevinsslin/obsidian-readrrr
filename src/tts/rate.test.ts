import { describe, it, expect } from "vitest";
import { clamp, wpmToRate, wpmToTimedAudioRate } from "./rate";

describe("clamp", () => {
  it("bounds a value into range", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });
});

describe("wpmToRate", () => {
  it("maps 200 wpm to normal rate", () => {
    expect(wpmToRate(200)).toBe(1);
  });

  it("clamps slow and fast extremes", () => {
    expect(wpmToRate(50)).toBe(0.5);
    expect(wpmToRate(100)).toBe(0.5);
    expect(wpmToRate(400)).toBe(2);
    expect(wpmToRate(5000)).toBe(4);
  });
});

describe("wpmToTimedAudioRate", () => {
  it("maps the full 1000 wpm UI range onto HTML audio", () => {
    expect(wpmToTimedAudioRate(100)).toBe(0.5);
    expect(wpmToTimedAudioRate(200)).toBe(1);
    expect(wpmToTimedAudioRate(800)).toBe(4);
    expect(wpmToTimedAudioRate(1000)).toBe(5);
    expect(wpmToTimedAudioRate(5000)).toBe(5);
  });
});
