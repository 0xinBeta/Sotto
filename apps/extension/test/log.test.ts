import { describe, expect, it } from "vitest";

import { nextLogEntry } from "../src/log.js";

describe("side-panel log deduplication", () => {
  it("collapses consecutive entries with the same kind and text", () => {
    const first = nextLogEntry(undefined, "system", "Grant microphone access");
    const second = nextLogEntry(
      first.entry,
      "system",
      "Grant microphone access",
    );
    const third = nextLogEntry(
      second.entry,
      "system",
      "Grant microphone access",
    );

    expect(first).toEqual({
      entry: {
        kind: "system",
        text: "Grant microphone access",
        count: 1,
      },
      collapsed: false,
    });
    expect(second.entry.count).toBe(2);
    expect(third).toEqual({
      entry: {
        kind: "system",
        text: "Grant microphone access",
        count: 3,
      },
      collapsed: true,
    });
  });

  it("starts a new entry when either the kind or text changes", () => {
    const previous = {
      kind: "system",
      text: "Grant microphone access",
      count: 4,
    };

    expect(nextLogEntry(previous, "microphone", previous.text).collapsed).toBe(
      false,
    );
    expect(nextLogEntry(previous, previous.kind, "Nano is unavailable")).toEqual({
      entry: {
        kind: "system",
        text: "Nano is unavailable",
        count: 1,
      },
      collapsed: false,
    });
  });
});
