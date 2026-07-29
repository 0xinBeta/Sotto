import type { TtsProgressEventType } from "@sotto/tts";

const MAX_CHUNK_CHARACTERS = 200;
const SENTENCE_ABBREVIATIONS = new Set([
  "capt",
  "col",
  "dept",
  "dr",
  "etc",
  "gen",
  "gov",
  "inc",
  "jr",
  "lt",
  "maj",
  "mr",
  "mrs",
  "ms",
  "prof",
  "rep",
  "sen",
  "sgt",
  "sr",
  "st",
  "vs",
]);

export interface ReadingChunk {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

export interface ReadingSentenceSpan {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

export interface ReadingPlan {
  readonly text: string;
  readonly chunks: readonly ReadingChunk[];
  readonly sentences: readonly ReadingSentenceSpan[];
}

export interface ReadingProgressPoint {
  readonly charIndex: number;
  readonly chunkIndex?: number;
  readonly chunkCount?: number;
  readonly eventType?: TtsProgressEventType;
}

function safeUtf16End(text: string, end: number): number {
  if (end <= 0 || end >= text.length) return end;
  const previous = text.charCodeAt(end - 1);
  const next = text.charCodeAt(end);
  return previous >= 0xd800 &&
      previous <= 0xdbff &&
      next >= 0xdc00 &&
      next <= 0xdfff
    ? end - 1
    : end;
}

function hardCapSentence(sentence: string): string[] {
  const chunks: string[] = [];
  let remaining = sentence.trim();
  while (remaining.length > MAX_CHUNK_CHARACTERS) {
    const maximum = safeUtf16End(remaining, MAX_CHUNK_CHARACTERS);
    const candidate = remaining.slice(0, maximum);
    const whitespace = candidate.lastIndexOf(" ");
    const boundary = whitespace >= Math.floor(maximum * 0.55)
      ? whitespace
      : maximum;
    chunks.push(remaining.slice(0, boundary).trim());
    remaining = remaining.slice(boundary).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function splitSentences(text: string): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [];

  const sentences: string[] = [];
  let start = 0;
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (
      character !== "." &&
      character !== "!" &&
      character !== "?" &&
      character !== "…"
    ) {
      continue;
    }

    let punctuationEnd = index + 1;
    while (
      punctuationEnd < normalized.length &&
      /[.!?…"'”’)\]]/.test(normalized[punctuationEnd] ?? "")
    ) {
      punctuationEnd += 1;
    }
    let next = punctuationEnd;
    while (next < normalized.length && /\s/.test(normalized[next] ?? "")) {
      next += 1;
    }
    if (next < normalized.length && next === punctuationEnd) continue;

    if (character === "." && next < normalized.length) {
      const tokenStart = normalized.lastIndexOf(" ", index - 1) + 1;
      const token = normalized.slice(tokenStart, index + 1);
      const bareToken = token.replace(/\.+$/, "").toLowerCase();
      if (
        SENTENCE_ABBREVIATIONS.has(bareToken) ||
        /^(?:[A-Za-z]\.){2,}$/.test(token) ||
        (/\d/.test(normalized[index - 1] ?? "") &&
          /\d/.test(normalized[index + 1] ?? "")) ||
        /[a-z]/.test(normalized[next] ?? "")
      ) {
        continue;
      }
    }

    const sentence = normalized.slice(start, punctuationEnd).trim();
    if (/[\p{L}\p{N}]/u.test(sentence)) sentences.push(sentence);
    start = punctuationEnd;
    while (start < normalized.length && /\s/.test(normalized[start] ?? "")) {
      start += 1;
    }
    index = start - 1;
  }

  const remainder = normalized.slice(start).trim();
  if (/[\p{L}\p{N}]/u.test(remainder)) sentences.push(remainder);
  return sentences;
}

export function createReadingPlan(text: string): ReadingPlan {
  const chunks: ReadingChunk[] = [];
  const sentences: ReadingSentenceSpan[] = [];
  let offset = 0;

  for (const sentence of splitSentences(text)) {
    const sentenceChunks = hardCapSentence(sentence);
    if (sentenceChunks.length === 0) continue;
    if (chunks.length > 0) offset += 1;
    const sentenceStart = offset;

    for (const [chunkIndex, chunkText] of sentenceChunks.entries()) {
      if (chunkIndex > 0) offset += 1;
      const start = offset;
      offset += chunkText.length;
      chunks.push({ text: chunkText, start, end: offset });
    }

    sentences.push({
      text: sentenceChunks.join(" "),
      start: sentenceStart,
      end: offset,
    });
  }

  return {
    text: chunks.map((chunk) => chunk.text).join(" "),
    chunks,
    sentences,
  };
}

export function splitReadingChunks(text: string): string[] {
  return createReadingPlan(text).chunks.map((chunk) => chunk.text);
}

export function activeReadingSentenceIndex(
  plan: ReadingPlan,
  progress: ReadingProgressPoint,
): number {
  if (plan.sentences.length === 0) return -1;

  const hasMatchingChunk = (
    progress.chunkCount === plan.chunks.length &&
    progress.chunkIndex !== undefined &&
    Number.isInteger(progress.chunkIndex) &&
    progress.chunkIndex >= 0 &&
    progress.chunkIndex < plan.chunks.length
  );
  const chunk = hasMatchingChunk
    ? plan.chunks[progress.chunkIndex!]
    : undefined;
  const boundary = chunk === undefined
    ? progress.charIndex
    : progress.eventType === "end"
      ? chunk.end
      : Math.max(chunk.start, Math.min(chunk.end, progress.charIndex));
  const bounded = Math.max(0, Math.min(plan.text.length, boundary));
  const sentenceIndex = plan.sentences.findIndex(
    (sentence) => bounded < sentence.end,
  );
  return sentenceIndex < 0 ? plan.sentences.length - 1 : sentenceIndex;
}
