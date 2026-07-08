import type { Token } from "./types";

export interface TokenizeOptions {
  /** Drop fenced code blocks (``` and ~~~) entirely. */
  skipCodeBlocks: boolean;
  /** Drop a leading YAML frontmatter block. */
  skipFrontmatter: boolean;
}

export const DEFAULT_TOKENIZE_OPTIONS: TokenizeOptions = {
  skipCodeBlocks: true,
  skipFrontmatter: true,
};

// Common abbreviations whose trailing period should NOT end a sentence.
const ABBREVIATIONS = new Set([
  "e.g.", "i.e.", "etc.", "vs.", "cf.", "al.",
  "mr.", "mrs.", "ms.", "dr.", "prof.", "st.", "jr.", "sr.",
  "fig.", "no.", "vol.", "pp.", "p.", "approx.",
]);

const CLOSERS = /[)\]"'”’»]+$/u;

/**
 * Reduce markdown source to plain prose. Paragraph breaks are preserved as
 * blank lines; everything else collapses to spaces. This is intentionally
 * pragmatic (regex-based), not a full CommonMark parser: it aims to produce
 * clean, readable words for RSVP, not a faithful AST.
 */
export function stripMarkdown(md: string, opts: TokenizeOptions): string {
  let text = md.replace(/\r\n?/g, "\n");

  if (opts.skipFrontmatter) {
    // Matches Obsidian semantics: a `---` fenced block at the very start of a
    // note is treated as frontmatter and removed.
    text = text.replace(/^---\n[\s\S]*?\n---\n?/, "\n");
  }

  if (opts.skipCodeBlocks) {
    text = text.replace(/^[ \t]*```[\s\S]*?^[ \t]*```/gm, "\n");
    text = text.replace(/^[ \t]*~~~[\s\S]*?^[ \t]*~~~/gm, "\n");
  } else {
    text = text.replace(/^[ \t]*```.*$/gm, "").replace(/^[ \t]*~~~.*$/gm, "");
  }

  // HTML comments.
  text = text.replace(/<!--[\s\S]*?-->/g, "");

  // Images (both markdown and Obsidian embeds) are dropped.
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
  text = text.replace(/!\[\[[^\]]*\]\]/g, "");

  // Wikilinks: [[target|alias]] -> alias, [[target]] -> target.
  text = text.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2");
  text = text.replace(/\[\[([^\]]+)\]\]/g, "$1");

  // Links: [text](url) -> text, [text][ref] -> text, <url> dropped.
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  text = text.replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1");
  text = text.replace(/<https?:\/\/[^>]+>/g, "");

  // Footnote references.
  text = text.replace(/\[\^[^\]]+\]/g, "");

  // Inline code (before emphasis so `**` inside code survives as literal).
  text = text.replace(/`([^`]+)`/g, "$1");

  // Emphasis with * and ~ (single line, inner must not start/end with space,
  // which keeps bullet markers like "* item" from matching).
  text = text.replace(/(\*\*\*|\*\*|\*)(?=\S)([^\n]*?\S)\1/g, "$2");
  text = text.replace(/(~~)(?=\S)([^\n]*?\S)\1/g, "$2");

  // Underscore emphasis, but only when flanked by boundaries so intraword
  // underscores (snake_case) are left alone. No lookbehind (older WebKit).
  text = text.replace(
    /(^|[^\w])(___|__|_)(?=\S)([^\n]*?\S)\2(?=[^\w]|$)/g,
    "$1$3",
  );

  // Highlight ==x==.
  text = text.replace(/==(?=\S)([^\n]*?\S)==/g, "$1");

  const lines = text.split("\n").map((line) => {
    let l = line;
    // Horizontal rule.
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) return "";
    // Link reference definition.
    if (/^\s*\[[^\]]+\]:\s+\S+/.test(l)) return "";
    // Table separator row (only dashes, colons, pipes, spaces).
    if (l.includes("-") && /^[\s|:-]+$/.test(l)) return "";
    // Blockquote markers.
    l = l.replace(/^\s*>+\s?/g, "");
    // ATX heading markers.
    l = l.replace(/^\s*#{1,6}\s+/, "");
    // List markers and task checkboxes.
    l = l.replace(/^\s*([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, "");
    // Table cell pipes.
    if (l.includes("|")) l = l.replace(/\|/g, " ");
    // Tags: drop the leading # but keep the word.
    l = l.replace(/(^|\s)#([A-Za-z0-9_/-]+)/g, "$1$2");
    // Remaining HTML tags.
    l = l.replace(/<\/?[a-zA-Z][^>]*>/g, "");
    // Unescape backslash-escaped punctuation.
    l = l.replace(/\\([\\`*_{}[\]()#+\-.!>~=|])/g, "$1");
    return l;
  });
  text = lines.join("\n");

  // Normalize blank lines to single paragraph breaks.
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

function endsSentence(word: string): boolean {
  const trimmed = word.replace(CLOSERS, "");
  if (!/[.!?…]$/u.test(trimmed)) return false;
  if (ABBREVIATIONS.has(trimmed.toLowerCase())) return false;
  return true;
}

function endsClause(word: string): boolean {
  const trimmed = word.replace(CLOSERS, "");
  return /[,;:—–]$/u.test(trimmed);
}

function hasWordChar(s: string): boolean {
  return /[\p{L}\p{N}]/u.test(s);
}

/**
 * Turn markdown source into an ordered list of display tokens with pacing
 * flags. Pure and deterministic: the same input always yields the same tokens.
 */
export function tokenize(md: string, options?: Partial<TokenizeOptions>): Token[] {
  const opts = { ...DEFAULT_TOKENIZE_OPTIONS, ...options };
  const text = stripMarkdown(md, opts);
  if (!text) return [];

  const tokens: Token[] = [];
  const paragraphs = text.split(/\n{2,}/);

  for (const para of paragraphs) {
    const words = para.split(/\s+/).filter((w) => w.length > 0);
    const paraStart = tokens.length;

    for (const raw of words) {
      if (!hasWordChar(raw)) {
        // Stray punctuation: fold its meaning into the previous word rather
        // than flashing a lone "." or ",".
        if (tokens.length > paraStart) {
          const prev = tokens[tokens.length - 1];
          if (endsSentence(raw)) prev.endsSentence = true;
          else if (endsClause(raw)) prev.endsClause = true;
        }
        continue;
      }
      const sentence = endsSentence(raw);
      tokens.push({
        text: raw,
        endsSentence: sentence,
        endsClause: !sentence && endsClause(raw),
        endsParagraph: false,
      });
    }

    if (tokens.length > paraStart) {
      tokens[tokens.length - 1].endsParagraph = true;
    }
  }

  return tokens;
}
