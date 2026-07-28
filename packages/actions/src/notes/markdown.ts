import {
  isNoteRecord,
  type NoteRecord,
} from "./storage.js";

export const MAX_NOTES_MARKDOWN_BYTES = 512 * 1024;

export interface MarkdownSerializationOptions {
  readonly maxBytes?: number;
}

export interface NotesMarkdownExport {
  readonly filename: string;
  readonly markdown: string;
  readonly dataUrl: string;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function wellFormed(value: string): string {
  return value.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu,
    "\uFFFD",
  );
}

function checkedMaximum(maxBytes: number | undefined): number {
  const maximum = maxBytes ?? MAX_NOTES_MARKDOWN_BYTES;
  if (!Number.isSafeInteger(maximum) || maximum < 1) {
    throw new RangeError("Markdown byte limit must be a positive integer");
  }
  return maximum;
}

export function serializeNotesMarkdown(
  notes: readonly NoteRecord[],
  options: MarkdownSerializationOptions = {},
): string {
  const maximum = checkedMaximum(options.maxBytes);
  const sorted = [...notes].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
  const sections = sorted.map((note, index) => {
    if (!isNoteRecord(note)) {
      throw new TypeError(`Invalid note at export index ${index}`);
    }
    const source = note.source
      ? `\n\nSource: ${wellFormed(note.source.title)}\n\nURL: ${wellFormed(note.source.url)}`
      : "";
    return [
      `## Note ${index + 1}`,
      `Created: ${note.createdAt}`,
      `Updated: ${note.updatedAt}`,
      "",
      wellFormed(note.body),
      source,
    ].join("\n");
  });
  const markdown = wellFormed(
    ["# Sotto Notes", ...sections].join("\n\n").trimEnd() + "\n",
  );

  const size = byteLength(markdown);
  if (size > maximum) {
    throw new RangeError(
      `Markdown export is ${size} bytes; maximum is ${maximum} bytes`,
    );
  }
  return markdown;
}

export function createNotesMarkdownExport(
  notes: readonly NoteRecord[],
  date: Date = new Date(),
  options: MarkdownSerializationOptions = {},
): NotesMarkdownExport {
  const timestamp = date.getTime();
  if (!Number.isFinite(timestamp)) {
    throw new TypeError("Export date must be valid");
  }
  const markdown = serializeNotesMarkdown(notes, options);
  const yyyyMmDd = date.toISOString().slice(0, 10);
  return {
    filename: `sotto-notes-${yyyyMmDd}.md`,
    markdown,
    dataUrl: `data:text/markdown;charset=utf-8,${encodeURIComponent(markdown)}`,
  };
}

