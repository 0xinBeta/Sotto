import { describe, expect, it } from "vitest";

import { CommandAliasCaptureSession } from "../src/command-alias-capture.js";

describe("command alias capture", () => {
  it("moves from phrase capture to target capture and confirmation", () => {
    const capture = new CommandAliasCaptureSession();

    capture.startPhrase();
    expect(capture.state).toEqual({ stage: "phrase" });

    capture.startTarget("daily page");
    expect(capture.state).toEqual({
      stage: "target",
      phrase: "daily page",
    });

    expect(
      capture.capture({
        action: "navigate",
        destination: "https://example.com",
      }),
    ).toBe(true);
    expect(capture.state).toEqual({
      stage: "confirm",
      phrase: "daily page",
      command: {
        action: "navigate",
        destination: "https://example.com",
      },
    });
  });

  it("captures only the next successful existing command", () => {
    const capture = new CommandAliasCaptureSession();
    capture.startTarget("daily page");

    expect(capture.capture({ action: "unknown" })).toBe(false);
    expect(capture.state.stage).toBe("target");
    expect(capture.capture({ action: "tabs", operation: "new" })).toBe(true);
    expect(capture.capture({ action: "help", mode: "read" })).toBe(false);
    expect(capture.state).toMatchObject({
      stage: "confirm",
      command: { action: "tabs", operation: "new" },
    });
  });

  it("clears target and confirmation state", () => {
    const capture = new CommandAliasCaptureSession();
    capture.startTarget("daily page");
    capture.cancel();
    expect(capture.state).toEqual({ stage: "idle" });

    capture.startTarget("daily page");
    capture.capture({ action: "tabs", operation: "new" });
    capture.complete();
    expect(capture.state).toEqual({ stage: "idle" });
  });
});
