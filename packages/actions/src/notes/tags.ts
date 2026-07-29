import { scoreFuzzyMatch } from "../tabs/match.js";

export const MAX_NOTE_TAG_LENGTH = 40;
const NOTE_TAG_MATCH_SCORE = 0.6;

export type TaggedNotesTranscriptCommand =
  | {
      readonly action: "notes";
      readonly operation: "create";
      readonly body: string;
      readonly tag: string;
    }
  | {
      readonly action: "notes";
      readonly operation: "read";
      readonly tag: string;
    };

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

export function normalizeNoteTag(value: string): string {
  return normalizeWhitespace(value);
}

export function parseTaggedNotesTranscript(
  transcript: string,
): TaggedNotesTranscriptCommand | undefined {
  const normalized = transcript.trim();
  const create = normalized.match(
    /^(?:(?:make|save)\s+a\s+)?note\s+under\s+([^:\n]+?)\s*:\s*(\S[\s\S]*)$/iu,
  );
  if (create) {
    const tag = normalizeNoteTag(create[1]!);
    const body = create[2]!.trim();
    if (tag.length >= 1 && tag.length <= MAX_NOTE_TAG_LENGTH) {
      return { action: "notes", operation: "create", body, tag };
    }
    return undefined;
  }

  const read = normalized.match(
    /^read\s+my\s+(.+?)\s+notes(?:\s+aloud)?[.!?]?$/iu,
  );
  if (!read) return undefined;
  const tag = normalizeNoteTag(read[1]!);
  return tag.length >= 1 && tag.length <= MAX_NOTE_TAG_LENGTH
    ? { action: "notes", operation: "read", tag }
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Takes tags only from the explicit transcript forms. Model-added tags are
 * removed from all other create and read commands.
 */
export function withTranscriptNoteTag(
  command: unknown,
  transcript: string,
): unknown {
  const tagged = parseTaggedNotesTranscript(transcript);
  if (tagged) return tagged;
  if (
    !isRecord(command) ||
    command.action !== "notes" ||
    (command.operation !== "create" && command.operation !== "read") ||
    !Object.hasOwn(command, "tag")
  ) {
    return command;
  }
  const { tag: _tag, ...untagged } = command;
  return untagged;
}

export function noteTagMatches(tag: string, query: string): boolean {
  const normalizedTag = normalizeNoteTag(tag);
  const normalizedQuery = normalizeNoteTag(query);
  if (!normalizedTag || !normalizedQuery) return false;
  return [normalizedTag, ...normalizedTag.split(" ")].some(
    (candidate) =>
      scoreFuzzyMatch(candidate, normalizedQuery) >= NOTE_TAG_MATCH_SCORE,
  );
}

export function filterNotesByTag<TNote extends { readonly tag?: string }>(
  notes: readonly TNote[],
  query: string,
): readonly TNote[] {
  return notes.filter(
    (note) => note.tag !== undefined && noteTagMatches(note.tag, query),
  );
}
