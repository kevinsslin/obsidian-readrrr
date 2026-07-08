import { describe, it, expect } from "vitest";
import { tokenize, stripMarkdown, DEFAULT_TOKENIZE_OPTIONS } from "./tokenizer";

const texts = (md: string) => tokenize(md).map((t) => t.text);

describe("tokenize: plain prose", () => {
  it("splits words and keeps trailing punctuation", () => {
    expect(texts("The quick brown fox.")).toEqual(["The", "quick", "brown", "fox."]);
  });

  it("returns nothing for empty or whitespace input", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("   \n\n  ")).toEqual([]);
  });
});

describe("tokenize: markdown stripping", () => {
  it("strips emphasis but preserves snake_case", () => {
    expect(texts("**bold** and *italic* and ~~gone~~")).toEqual([
      "bold", "and", "italic", "and", "gone",
    ]);
    expect(texts("_emph_ but not my_snake_case_var")).toEqual([
      "emph", "but", "not", "my_snake_case_var",
    ]);
  });

  it("unwraps links and wikilinks", () => {
    expect(texts("see [the docs](https://x.com) now")).toEqual(["see", "the", "docs", "now"]);
    expect(texts("a [[Note Title]] here")).toEqual(["a", "Note", "Title", "here"]);
    expect(texts("a [[target|Alias Shown]] here")).toEqual(["a", "Alias", "Shown", "here"]);
  });

  it("keeps inline code text without backticks", () => {
    expect(texts("run `npm test` please")).toEqual(["run", "npm", "test", "please"]);
  });

  it("strips headings, blockquotes, and list markers", () => {
    expect(texts("# Title")).toEqual(["Title"]);
    expect(texts("> quoted line")).toEqual(["quoted", "line"]);
    expect(texts("- item one\n- item two")).toEqual(["item", "one", "item", "two"]);
    expect(texts("1. first\n2. second")).toEqual(["first", "second"]);
    expect(texts("- [ ] todo task")).toEqual(["todo", "task"]);
  });

  it("drops images but keeps a tag's word", () => {
    expect(texts("before ![alt](img.png) after")).toEqual(["before", "after"]);
    expect(texts("a #project note")).toEqual(["a", "project", "note"]);
  });

  it("skips YAML frontmatter by default", () => {
    const md = "---\ntitle: Hello\ntags: [a, b]\n---\n\nReal body text.";
    expect(texts(md)).toEqual(["Real", "body", "text."]);
  });

  it("skips fenced code blocks by default", () => {
    const md = "Intro line.\n\n```js\nconst x = 1;\n```\n\nOutro line.";
    expect(texts(md)).toEqual(["Intro", "line.", "Outro", "line."]);
  });

  it("can keep code block contents when configured", () => {
    const md = "```\nhello world\n```";
    expect(tokenize(md, { skipCodeBlocks: false }).map((t) => t.text)).toEqual([
      "hello", "world",
    ]);
  });

  it("flattens table cells", () => {
    const md = "| A | B |\n| --- | --- |\n| one | two |";
    expect(texts(md)).toEqual(["A", "B", "one", "two"]);
  });
});

describe("tokenize: pacing flags", () => {
  it("marks sentence ends", () => {
    const t = tokenize("Hello world. Next one!");
    expect(t.find((x) => x.text === "world.")?.endsSentence).toBe(true);
    expect(t.find((x) => x.text === "one!")?.endsSentence).toBe(true);
    expect(t.find((x) => x.text === "Hello")?.endsSentence).toBe(false);
  });

  it("marks clause ends but not as sentence ends", () => {
    const t = tokenize("First, then second; finally third.");
    const first = t.find((x) => x.text === "First,");
    expect(first?.endsClause).toBe(true);
    expect(first?.endsSentence).toBe(false);
  });

  it("does not treat common abbreviations as sentence ends", () => {
    const t = tokenize("Use e.g. this and cf. that.");
    expect(t.find((x) => x.text === "e.g.")?.endsSentence).toBe(false);
    expect(t.find((x) => x.text === "cf.")?.endsSentence).toBe(false);
    expect(t.find((x) => x.text === "that.")?.endsSentence).toBe(true);
  });

  it("treats an ellipsis as a sentence end", () => {
    const t = tokenize("Wait… what?");
    expect(t.find((x) => x.text === "Wait…")?.endsSentence).toBe(true);
  });

  it("handles sentence end before a closing quote or paren", () => {
    const t = tokenize('He said "done."');
    expect(t[t.length - 1].endsSentence).toBe(true);
  });

  it("folds a stray punctuation token into the previous word", () => {
    // The lone "." should not become its own token.
    const t = tokenize('She said "hi" . Then left.');
    expect(t.map((x) => x.text)).not.toContain(".");
    const hi = t.find((x) => x.text.startsWith('"hi"') || x.text === '"hi"');
    expect(hi?.endsSentence).toBe(true);
  });

  it("marks the last token of each paragraph", () => {
    const t = tokenize("Para one here.\n\nPara two here.");
    const endsPara = t.filter((x) => x.endsParagraph).map((x) => x.text);
    expect(endsPara).toEqual(["here.", "here."]);
    // Only the paragraph-final tokens are flagged.
    expect(t.filter((x) => x.endsParagraph)).toHaveLength(2);
  });
});

describe("stripMarkdown", () => {
  it("preserves paragraph breaks as blank lines", () => {
    const out = stripMarkdown("# A\n\nB\n\n\n\nC", DEFAULT_TOKENIZE_OPTIONS);
    expect(out).toBe("A\n\nB\n\nC");
  });

  it("unescapes backslash-escaped punctuation attached to a word", () => {
    expect(texts("I love C\\+\\+ code")).toEqual(["I", "love", "C++", "code"]);
  });

  it("drops standalone symbol-only tokens (nothing to read aloud)", () => {
    expect(texts("a \\* b")).toEqual(["a", "b"]);
    expect(texts("one -> two")).toEqual(["one", "two"]);
  });
});
