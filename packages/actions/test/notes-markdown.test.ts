import { describe, expect, it } from "vitest";

import {
  createNotesMarkdownExport,
  serializeNotesMarkdown,
} from "../src/notes/markdown.js";
import type { NoteRecord } from "../src/notes/storage.js";

function note(
  id: string,
  body: string,
  createdAt: string,
  source?: NoteRecord["source"],
): NoteRecord {
  return {
    id,
    body,
    createdAt,
    updatedAt: createdAt,
    ...(source ? { source } : {}),
  };
}

describe("notes Markdown export", () => {
  it("serializes notes chronologically with plain source metadata", () => {
    const markdown = serializeNotesMarkdown([
      note("later", "Second note", "2026-07-28T12:00:00.000Z"),
      note("earlier", "First note", "2026-07-27T12:00:00.000Z", {
        title: "Example [page]",
        url: "https://example.test/a_(b)",
      }),
    ]);

    expect(markdown).toContain("# Sotto Notes");
    expect(markdown.indexOf("First note")).toBeLessThan(
      markdown.indexOf("Second note"),
    );
    expect(markdown).toContain("Source: Example [page]");
    expect(markdown).toContain("URL: https://example.test/a_(b)");
  });

  it("includes optional note tags as plain metadata", () => {
    const tagged = {
      ...note("tagged", "Build note", "2026-07-28T12:00:00.000Z"),
      tag: "project apollo",
    };

    expect(serializeNotesMarkdown([tagged])).toContain(
      "Tag: project apollo\n\nBuild note",
    );
  });

  it("creates a bounded worker-safe data URL without calling downloads", () => {
    const result = createNotesMarkdownExport(
      [note("one", "A note", "2026-07-28T12:00:00.000Z")],
      new Date("2026-07-28T18:00:00.000Z"),
    );

    expect(result.filename).toBe("sotto-notes-2026-07-28.md");
    expect(result.dataUrl).toBe(
      `data:text/markdown;charset=utf-8,${encodeURIComponent(result.markdown)}`,
    );
  });

  it("rejects output over the configured UTF-8 byte bound", () => {
    const notes = [
      note("one", "Four-byte: 😀", "2026-07-28T12:00:00.000Z"),
    ];
    const full = serializeNotesMarkdown(notes);
    const bytes = new TextEncoder().encode(full).byteLength;

    expect(() =>
      serializeNotesMarkdown(notes, { maxBytes: bytes - 1 }),
    ).toThrow(`maximum is ${bytes - 1} bytes`);
    expect(serializeNotesMarkdown(notes, { maxBytes: bytes })).toBe(full);
  });
});
