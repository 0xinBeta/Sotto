import type { ActionCommand } from "@sotto/core";
import type { ParserMemoryExchange } from "@sotto/nano";
import { describe, expect, expectTypeOf, it } from "vitest";

import {
  COMPLETED_RESULT_SUMMARY,
  FollowUpMemory,
  resolveFollowUpCommand,
} from "../src/follow-up-memory.js";

describe("follow-up memory", () => {
  it("keeps only the two newest completed exchanges", () => {
    const memory = new FollowUpMemory();
    memory.record("first", { action: "tabs", operation: "new" }, 1_000);
    memory.record("second", { action: "tabs", operation: "count" }, 2_000);
    memory.record("third", { action: "tabs", operation: "close" }, 3_000);

    expect(memory.recent(3_000).map((entry) => entry.transcript)).toEqual([
      "second",
      "third",
    ]);
  });

  it("keeps entries for 30 seconds and removes older entries", () => {
    const memory = new FollowUpMemory();
    memory.record("first", { action: "tabs", operation: "new" }, 1_000);
    memory.record("second", { action: "tabs", operation: "count" }, 1_001);

    expect(memory.recent(31_000).map((entry) => entry.transcript)).toEqual([
      "first",
      "second",
    ]);
    expect(memory.recent(31_002)).toEqual([]);
  });

  it("does not record the unknown fallback", () => {
    const memory = new FollowUpMemory();
    memory.record("unclear", { action: "unknown" }, 1_000);

    expect(memory.recent(1_000)).toEqual([]);
  });

  it("stores only the approved exchange structure and a fixed summary", () => {
    expectTypeOf<keyof ParserMemoryExchange>().toEqualTypeOf<
      "transcript" | "command" | "resultSummary"
    >();

    const memory = new FollowUpMemory();
    const command = {
      action: "summarize",
      mode: "summarize",
      scope: "page",
    } satisfies ActionCommand;
    memory.record("summarize this page", command, 1_000);

    const [entry] = memory.recent(1_000);
    expect(entry).toEqual({
      transcript: "summarize this page",
      command,
      resultSummary: COMPLETED_RESULT_SUMMARY,
    });
    expect(Object.keys(entry ?? {}).sort()).toEqual([
      "command",
      "resultSummary",
      "transcript",
    ]);
    expect(JSON.stringify(entry)).not.toContain("pageText");
    expect(JSON.stringify(entry)).not.toContain("title");
    expect(JSON.stringify(entry)).not.toContain("modelOutput");
  });

  it("clears all session entries", () => {
    const memory = new FollowUpMemory();
    memory.record("new tab", { action: "tabs", operation: "new" }, 1_000);

    memory.clear();

    expect(memory.recent(1_000)).toEqual([]);
  });
});

describe("follow-up command resolution", () => {
  const correctedSwitch = {
    action: "tabs",
    operation: "switch",
    target: "the other one",
    correction: true,
  } satisfies ActionCommand;

  it("uses the newest prior validated switch target", () => {
    const memory: readonly ParserMemoryExchange[] = [
      {
        transcript: "switch to GitHub",
        command: {
          action: "tabs",
          operation: "switch",
          target: "GitHub",
        },
        resultSummary: COMPLETED_RESULT_SUMMARY,
      },
    ];

    expect(resolveFollowUpCommand(correctedSwitch, memory)).toEqual({
      ...correctedSwitch,
      target: "GitHub",
    });
  });

  it("fails closed when the newest prior command is not a tab switch", () => {
    const memory: readonly ParserMemoryExchange[] = [
      {
        transcript: "switch to GitHub",
        command: {
          action: "tabs",
          operation: "switch",
          target: "GitHub",
        },
        resultSummary: COMPLETED_RESULT_SUMMARY,
      },
      {
        transcript: "count my tabs",
        command: { action: "tabs", operation: "count" },
        resultSummary: COMPLETED_RESULT_SUMMARY,
      },
    ];

    expect(resolveFollowUpCommand(correctedSwitch, memory)).toEqual({
      action: "unknown",
    });
  });

  it("leaves commands without a correction marker unchanged", () => {
    const command = {
      action: "tabs",
      operation: "switch",
      target: "GitHub",
    } satisfies ActionCommand;

    expect(resolveFollowUpCommand(command, [])).toBe(command);
  });
});
