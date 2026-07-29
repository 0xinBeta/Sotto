import { describe, expect, it } from "vitest";
import { validateSchema } from "@sotto/core";

import playbackAction, {
  playbackSchema,
} from "../src/playback/index.js";

describe("playback action", () => {
  it.each(["pause", "resume", "stop", "skip"] as const)(
    "accepts the %s operation",
    (operation) => {
      expect(
        validateSchema(playbackSchema, {
          action: "playback",
          operation,
        }).valid,
      ).toBe(true);
    },
  );

  it("rejects extra playback payload", () => {
    expect(
      validateSchema(playbackSchema, {
        action: "playback",
        operation: "pause",
        text: "page-derived text",
      }).valid,
    ).toBe(false);
  });

  it("returns short control status text", async () => {
    await expect(
      playbackAction.execute(
        { action: "playback", operation: "skip" },
        {},
      ),
    ).resolves.toEqual({ spoken: "Skipped one sentence." });
  });
});
