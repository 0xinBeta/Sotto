import { validateSchema } from "@sotto/core";
import { describe, expect, it, vi } from "vitest";

import mediaAction, {
  mediaSchema,
  type MediaOperation,
} from "../src/media/index.js";

describe("media schema", () => {
  it.each([
    "pause",
    "play",
  ] satisfies readonly MediaOperation[])("accepts %s", (operation) => {
    expect(
      validateSchema(mediaSchema, {
        action: "media",
        operation,
      }),
    ).toEqual({ valid: true, errors: [] });
  });

  it("rejects media values outside the closed operation set", () => {
    expect(
      validateSchema(mediaSchema, {
        action: "media",
        operation: "seek",
      }).valid,
    ).toBe(false);
    expect(
      validateSchema(mediaSchema, {
        action: "media",
        operation: "play",
        url: "https://page.example/video",
      }).valid,
    ).toBe(false);
  });
});

describe("media action responses", () => {
  it.each([
    ["pause", "paused", "Paused."],
    ["play", "playing", "Playing."],
  ] as const)("maps %s success to a short line", async (
    operation,
    status,
    spoken,
  ) => {
    const run = vi.fn().mockResolvedValue({ status });

    await expect(
      mediaAction.execute(
        { action: "media", operation },
        { media: { run } },
      ),
    ).resolves.toEqual({ spoken });
    expect(run).toHaveBeenCalledWith(operation);
  });

  it("uses the blocked-playback instruction after play rejects", async () => {
    await expect(
      mediaAction.execute(
        { action: "media", operation: "play" },
        {
          media: {
            run: vi.fn().mockResolvedValue({ status: "blocked" }),
          },
        },
      ),
    ).resolves.toEqual({
      spoken: "The page blocked playback. Click the video once.",
    });
  });

  it("uses the no-media line when the page has no reachable media", async () => {
    await expect(
      mediaAction.execute(
        { action: "media", operation: "pause" },
        {
          media: {
            run: vi.fn().mockResolvedValue({ status: "no-media" }),
          },
        },
      ),
    ).resolves.toEqual({
      spoken: "I found no video or audio here.",
    });
  });
});
