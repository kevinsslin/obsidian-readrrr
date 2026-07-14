import type { SourceRange } from "./core/align";
import type { Token } from "./core/types";

export interface ReadingCheckpoint {
  version: 1;
  filePath: string;
  tokenIndex: number;
  totalTokens: number;
  progress: number;
  sourceOffset: number | null;
  previousToken: string | null;
  currentToken: string;
  nextToken: string | null;
  updatedAt: number;
}

function normalizedToken(text: string): string {
  return text.normalize("NFKC").toLocaleLowerCase();
}

function clampIndex(index: number, total: number): number {
  return Math.max(0, Math.min(total - 1, Math.round(index)));
}

export function isReadingCheckpoint(value: unknown): value is ReadingCheckpoint {
  if (!value || typeof value !== "object") return false;
  const checkpoint = value as Partial<ReadingCheckpoint>;
  const tokenIndex = checkpoint.tokenIndex;
  const totalTokens = checkpoint.totalTokens;
  const progress = checkpoint.progress;
  const sourceOffset = checkpoint.sourceOffset;
  const updatedAt = checkpoint.updatedAt;
  return (
    checkpoint.version === 1 &&
    typeof checkpoint.filePath === "string" &&
    typeof tokenIndex === "number" &&
    Number.isInteger(tokenIndex) &&
    tokenIndex >= 0 &&
    typeof totalTokens === "number" &&
    Number.isInteger(totalTokens) &&
    totalTokens > 0 &&
    tokenIndex < totalTokens &&
    typeof progress === "number" &&
    Number.isFinite(progress) &&
    progress >= 0 &&
    progress <= 1 &&
    (sourceOffset === null ||
      (typeof sourceOffset === "number" &&
        Number.isInteger(sourceOffset) &&
        sourceOffset >= 0)) &&
    (checkpoint.previousToken === null || typeof checkpoint.previousToken === "string") &&
    typeof checkpoint.currentToken === "string" &&
    (checkpoint.nextToken === null || typeof checkpoint.nextToken === "string") &&
    typeof updatedAt === "number" &&
    Number.isFinite(updatedAt) &&
    updatedAt >= 0
  );
}

export function createCheckpoint(
  filePath: string,
  tokens: Token[],
  ranges: Array<SourceRange | null>,
  index: number,
  updatedAt = Date.now(),
): ReadingCheckpoint | null {
  if (tokens.length === 0) return null;
  const current = clampIndex(index, tokens.length);
  return {
    version: 1,
    filePath,
    tokenIndex: current,
    totalTokens: tokens.length,
    progress: tokens.length > 1 ? current / (tokens.length - 1) : 0,
    sourceOffset: ranges[current]?.start ?? null,
    previousToken: current > 0 ? tokens[current - 1].text : null,
    currentToken: tokens[current].text,
    nextToken: current + 1 < tokens.length ? tokens[current + 1].text : null,
    updatedAt,
  };
}

/** Resolve a saved checkpoint after the note or tokenizer may have changed. */
export function resolveCheckpoint(
  checkpoint: ReadingCheckpoint,
  tokens: Token[],
  ranges: Array<SourceRange | null>,
): number {
  if (tokens.length === 0) return 0;
  const expected = clampIndex(checkpoint.progress * (tokens.length - 1), tokens.length);
  const currentText = normalizedToken(checkpoint.currentToken);

  // Fast path for an unchanged note and tokenization configuration.
  const savedIndex = clampIndex(checkpoint.tokenIndex, tokens.length);
  if (
    normalizedToken(tokens[savedIndex].text) === currentText &&
    (checkpoint.sourceOffset === null || ranges[savedIndex]?.start === checkpoint.sourceOffset)
  ) {
    return savedIndex;
  }

  // Locate the same token with its nearby context. This survives text inserted
  // before the checkpoint and disambiguates common repeated words.
  let bestIndex: number | null = null;
  let bestContext = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < tokens.length; i++) {
    if (normalizedToken(tokens[i].text) !== currentText) continue;
    let context = 1;
    if (
      checkpoint.previousToken !== null &&
      i > 0 &&
      normalizedToken(tokens[i - 1].text) === normalizedToken(checkpoint.previousToken)
    ) {
      context++;
    }
    if (
      checkpoint.nextToken !== null &&
      i + 1 < tokens.length &&
      normalizedToken(tokens[i + 1].text) === normalizedToken(checkpoint.nextToken)
    ) {
      context++;
    }
    const distance = Math.abs(i - expected);
    if (context > bestContext || (context === bestContext && distance < bestDistance)) {
      bestIndex = i;
      bestContext = context;
      bestDistance = distance;
    }
  }
  if (bestIndex !== null) return bestIndex;

  // If the anchor text itself changed, use the nearest surviving source offset.
  if (checkpoint.sourceOffset !== null) {
    let nearestIndex: number | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (let i = 0; i < ranges.length; i++) {
      const range = ranges[i];
      if (!range) continue;
      const distance = Math.abs(range.start - checkpoint.sourceOffset);
      if (distance < nearestDistance) {
        nearestIndex = i;
        nearestDistance = distance;
      }
    }
    if (nearestIndex !== null) return nearestIndex;
  }

  return expected;
}
