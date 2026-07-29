import { describe, expect, it } from "vitest";

import {
  selectSpokenLine,
  spokenLine,
  SPOKEN_LINE_KEYS,
  type SpokenLineKey,
} from "../src/spoken-lines.js";

const KNOWN_KEYS: readonly SpokenLineKey[] = [
  "done",
  "bookmark-created",
  "note-saved",
  "note-deleted",
  "reminder-set",
  "reminder-cancelled",
  "cancelled",
  "tab-opened",
  "tab-closed",
  "tab-reopened",
  "tab-grouped",
  "tab-ungrouped",
  "tabs-ungrouped",
  "tab-groups-collapsed",
  "tab-groups-expanded",
  "typed",
  "rewritten",
  "searching",
  "screenshot-copied",
  "media-paused",
  "media-playing",
];

describe("spoken confirmation lines", () => {
  it("defines normal and brief text for every known key", () => {
    expect(SPOKEN_LINE_KEYS).toEqual(KNOWN_KEYS);

    for (const key of KNOWN_KEYS) {
      const normal = spokenLine(key, "normal");
      const brief = spokenLine(key, "brief");
      expect(normal).toMatch(/[.!?]$/u);
      expect(brief).toMatch(/[.!?]$/u);
      expect(brief.trim().split(/\s+/u)).toHaveLength(1);
      expect(selectSpokenLine(normal, "brief")).toEqual({
        text: brief,
        key,
      });
    }
  });

  it("does not change informational lines or errors", () => {
    for (const text of [
      "You have 12 tabs open.",
      "Your reminder is set for 4:30 PM.",
      "Here is the Turkish translation.",
      "The answer is forty-two.",
      "Screenshot saved to Downloads.",
      "I could not save the screenshot.",
    ]) {
      expect(selectSpokenLine(text, "brief")).toEqual({ text });
    }
  });

  it("keeps the group title in normal mode and shortens brief mode", () => {
    expect(selectSpokenLine("Grouped as research.", "normal")).toEqual({
      text: "Grouped as research.",
      key: "tab-grouped",
    });
    expect(selectSpokenLine("Grouped as research.", "brief")).toEqual({
      text: "Grouped.",
      key: "tab-grouped",
    });
  });
});
