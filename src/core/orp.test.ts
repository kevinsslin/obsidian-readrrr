import { describe, it, expect } from "vitest";
import { orpIndex, splitOrp } from "./orp";

describe("orpIndex", () => {
  it("follows the OpenSpritz pivot table", () => {
    expect(orpIndex("")).toBe(0);
    expect(orpIndex("a")).toBe(0);
    expect(orpIndex("at")).toBe(1);
    expect(orpIndex("cats")).toBe(1);
    expect(orpIndex("reads")).toBe(1); // length 5
    expect(orpIndex("reader")).toBe(2); // length 6
    expect(orpIndex("wonderful")).toBe(2); // length 9
    expect(orpIndex("everything")).toBe(3); // length 10
    expect(orpIndex("abcdefghijklm")).toBe(3); // length 13
    expect(orpIndex("abcdefghijklmn")).toBe(4); // length 14
    expect(orpIndex("supercalifragilistic")).toBe(4);
  });
});

describe("splitOrp", () => {
  it("splits around a single pivot character that reconstructs the word", () => {
    for (const word of ["a", "at", "reading", "everything", "extraordinary"]) {
      const { before, pivot, after } = splitOrp(word);
      expect(before + pivot + after).toBe(word);
      expect(pivot.length).toBe(1);
    }
  });

  it("places the pivot per the table", () => {
    expect(splitOrp("reading")).toEqual({ before: "re", pivot: "a", after: "ding" });
    expect(splitOrp("a")).toEqual({ before: "", pivot: "a", after: "" });
    expect(splitOrp("to")).toEqual({ before: "t", pivot: "o", after: "" });
  });

  it("handles an empty word without throwing", () => {
    expect(splitOrp("")).toEqual({ before: "", pivot: "", after: "" });
  });

  it("splits by code points so surrogate pairs stay intact", () => {
    const s = splitOrp("a😀b😀c"); // 5 code points -> pivot at index 1
    expect(s.before + s.pivot + s.after).toBe("a😀b😀c");
    expect([...s.pivot]).toHaveLength(1); // one code point, not half a surrogate
    expect(s.pivot).toBe("😀");
  });
});
