/**
 * Optimal Recognition Point (ORP): the letter a reader's eye should fixate on
 * so a word is recognized fastest. RSVP keeps this pivot at a fixed horizontal
 * position for every word, which is what removes eye movement.
 *
 * The pivot table matches the widely used OpenSpritz/Spreed convention.
 */
export function orpIndex(word: string): number {
  // Count Unicode code points, not UTF-16 units, so emoji/surrogate pairs
  // count as one character.
  const len = [...word].length;
  if (len <= 1) return 0;
  if (len <= 5) return 1;
  if (len <= 9) return 2;
  if (len <= 13) return 3;
  return 4;
}

export interface OrpSplit {
  /** Characters before the pivot. */
  before: string;
  /** The single pivot character (empty only for an empty word). */
  pivot: string;
  /** Characters after the pivot. */
  after: string;
}

/**
 * Split a word into the part before the pivot, the pivot character, and the
 * part after, so the three can be laid out with the pivot centered.
 */
export function splitOrp(word: string): OrpSplit {
  // Split on code points so a surrogate pair (e.g. an emoji) is never cut in
  // half, which would render as replacement characters.
  const chars = [...word];
  if (chars.length === 0) return { before: "", pivot: "", after: "" };
  const i = Math.min(orpIndex(word), chars.length - 1);
  return {
    before: chars.slice(0, i).join(""),
    pivot: chars[i],
    after: chars.slice(i + 1).join(""),
  };
}
