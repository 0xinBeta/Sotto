/**
 * Chrome accepts at most 32,768 UTF-16 code units per utterance. Keeping the
 * guard one code unit below that limit makes the invariant unambiguous.
 */
export const MAX_TTS_UTTERANCE_LENGTH = 32_767;

export const MIN_TTS_CHUNK_LENGTH = 2_000;
export const TARGET_TTS_CHUNK_LENGTH = 3_000;
export const MAX_TTS_CHUNK_LENGTH = 4_000;

const PARAGRAPH_BOUNDARY = /\n{2,}/g;
const SENTENCE_BOUNDARY =
  /[.!?](?:["'”’)\]}»])?(?:[ \t]+|\n+)|[…。！？](?:["'”’)\]}»])?[ \t\n]*/g;
const LINE_BOUNDARY = /\n+/g;
const WHITESPACE_BOUNDARY = /\s+/g;

export function normalizeTtsText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function closestBoundary(
  text: string,
  start: number,
  end: number,
  pattern: RegExp,
): number | undefined {
  pattern.lastIndex = start;
  let best: number | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    const boundary = match.index + match[0].length;
    if (boundary > end) {
      break;
    }
    const chunkLength = text.slice(start, boundary).trim().length;
    if (chunkLength < MIN_TTS_CHUNK_LENGTH) {
      continue;
    }

    const distance = Math.abs(
      chunkLength - TARGET_TTS_CHUNK_LENGTH,
    );
    if (distance < bestDistance || (distance === bestDistance && boundary > (best ?? 0))) {
      best = boundary;
      bestDistance = distance;
    }
  }

  return best;
}

function chooseBoundary(text: string, start: number, end: number): number {
  return closestBoundary(text, start, end, PARAGRAPH_BOUNDARY) ??
    closestBoundary(text, start, end, SENTENCE_BOUNDARY) ??
    closestBoundary(text, start, end, LINE_BOUNDARY) ??
    closestBoundary(text, start, end, WHITESPACE_BOUNDARY) ??
    end;
}

/**
 * Splits normalized text deterministically into moderate utterances, preferring
 * paragraph and sentence boundaries before line and word boundaries.
 */
export function chunkTextForTts(text: string): string[] {
  const normalized = normalizeTtsText(text);
  if (!normalized) {
    return [];
  }

  const chunks: string[] = [];
  let start = 0;

  while (normalized.length - start > MAX_TTS_CHUNK_LENGTH) {
    const remainingLength = normalized.length - start;
    const balancedMaximumLength = Math.min(
      MAX_TTS_CHUNK_LENGTH,
      remainingLength - MIN_TTS_CHUNK_LENGTH,
    );
    const maximumEnd = Math.min(
      normalized.length,
      start + balancedMaximumLength,
    );
    const boundary = chooseBoundary(normalized, start, maximumEnd);
    const chunk = normalized.slice(start, boundary).trim();

    // `chooseBoundary` always advances, but keep this guard local to the
    // chunker so a future boundary rule cannot create an infinite loop.
    if (!chunk) {
      start = maximumEnd;
      continue;
    }

    chunks.push(chunk);
    start = boundary;
    while (start < normalized.length && /\s/.test(normalized[start] ?? "")) {
      start += 1;
    }
  }

  const finalChunk = normalized.slice(start).trim();
  if (finalChunk) {
    chunks.push(finalChunk);
  }

  return chunks;
}

export const chunkText = chunkTextForTts;
