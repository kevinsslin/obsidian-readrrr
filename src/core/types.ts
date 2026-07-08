/**
 * A single unit shown in the RSVP display. `text` keeps its trailing
 * punctuation (Spritz-style) so the reader sees natural words like "Hello,".
 * The boolean flags drive pacing: the scheduler dwells longer on words that
 * end a clause, sentence, or paragraph.
 */
export interface Token {
  /** Display text, markdown stripped, punctuation kept. */
  text: string;
  /** Ends a sentence (`.`, `!`, `?`, `…`), excluding common abbreviations. */
  endsSentence: boolean;
  /** Ends a clause (comma, semicolon, colon, or dash) and not a sentence. */
  endsClause: boolean;
  /** Last word of its paragraph/block. */
  endsParagraph: boolean;
}

/** One scheduled word: when it appears and for how long. */
export interface TimelineEntry {
  index: number;
  token: Token;
  /** Milliseconds from the start of the run when this word appears. */
  startMs: number;
  /** How long this word stays on screen, in milliseconds. */
  durationMs: number;
}
