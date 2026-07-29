import { describe, expect, it } from "vitest";

import {
  deriveNoteTagChips,
  filterPanelNotes,
  MAX_VISIBLE_NOTE_TAGS,
} from "../src/note-filters.js";

describe("note tag filters", () => {
  it("orders tags by use, sorts ties, merges case, and caps the row", () => {
    const notes = [
      { body: "One", tag: "Project Apollo" },
      { body: "Two", tag: "project apollo" },
      ...Array.from(
        { length: MAX_VISIBLE_NOTE_TAGS + 2 },
        (_, index) => ({ body: `Body ${index}`, tag: `tag ${index}` }),
      ),
    ];

    const chips = deriveNoteTagChips(notes);

    expect(chips).toHaveLength(MAX_VISIBLE_NOTE_TAGS);
    expect(chips[0]).toEqual({ tag: "Project Apollo", count: 2 });
    expect(chips.slice(1).map((chip) => chip.tag)).toEqual(
      [...chips.slice(1).map((chip) => chip.tag)].sort((left, right) =>
        left.localeCompare(right, "en-US")
      ),
    );
    expect(chips).not.toContainEqual({ tag: "tag 9", count: 1 });
  });

  it("combines body search and the selected tag", () => {
    const notes = [
      { body: "Benchmark the build", tag: "project apollo" },
      { body: "Call the team", tag: "project apollo" },
      { body: "Benchmark the recipe", tag: "home" },
      { body: "Benchmark without a tag" },
    ];

    expect(filterPanelNotes(notes, "BENCHMARK", "PROJECT APOLLO")).toEqual([
      notes[0],
    ]);
    expect(filterPanelNotes(notes, "benchmark")).toEqual([
      notes[0],
      notes[2],
      notes[3],
    ]);
  });
});
