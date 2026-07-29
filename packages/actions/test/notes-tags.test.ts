import { describe, expect, it } from "vitest";

import {
  filterNotesByTag,
  MAX_NOTE_TAG_LENGTH,
  parseTaggedNotesTranscript,
  withTranscriptNoteTag,
} from "../src/notes/tags.js";

describe("note tags", () => {
  it("extracts the tag before the first colon and the full body after it", () => {
    expect(
      parseTaggedNotesTranscript(
        "note under project apollo: benchmark: nightly build",
      ),
    ).toEqual({
      action: "notes",
      operation: "create",
      tag: "project apollo",
      body: "benchmark: nightly build",
    });
  });

  it("bounds tags and accepts the exact maximum", () => {
    const accepted = "a".repeat(MAX_NOTE_TAG_LENGTH);
    expect(
      parseTaggedNotesTranscript(`note under ${accepted}: keep this`),
    ).toMatchObject({ tag: accepted });
    expect(
      parseTaggedNotesTranscript(
        `note under ${accepted}a: do not add a tag`,
      ),
    ).toBeUndefined();
  });

  it.each([
    "note that down: check the benchmark",
    "make a note to compare speech models",
    "save a note: call Sam",
    "remember this note: ship on Friday",
  ])("does not grow a tag for an untagged phrase: %s", (transcript) => {
    expect(
      withTranscriptNoteTag(
        {
          action: "notes",
          operation: "create",
          body: "Transcript note",
          tag: "invented",
        },
        transcript,
      ),
    ).toEqual({
      action: "notes",
      operation: "create",
      body: "Transcript note",
    });
  });

  it("extracts a filtered recall target from the transcript", () => {
    expect(parseTaggedNotesTranscript("read my apollo notes")).toEqual({
      action: "notes",
      operation: "read",
      tag: "apollo",
    });
  });

  it("fuzzy-matches all applicable tags and excludes untagged notes", () => {
    const notes = [
      { body: "One", tag: "project apollo" },
      { body: "Two", tag: "apollo" },
      { body: "Three", tag: "home" },
      { body: "Four" },
    ];

    expect(
      filterNotesByTag(notes, "project apolo").map((note) => note.body),
    ).toEqual(["One"]);
    expect(
      filterNotesByTag(notes, "apolo").map((note) => note.body),
    ).toEqual(["One", "Two"]);
  });
});
