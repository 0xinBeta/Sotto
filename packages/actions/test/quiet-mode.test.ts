import { describe, expect, it } from "vitest";

import { validateSchema } from "@sotto/core";
import quietModeAction, {
  quietModeSchema,
} from "../src/quiet-mode/index.js";

describe("quiet mode action", () => {
  it("accepts only on and off operations", () => {
    expect(
      validateSchema(quietModeSchema, {
        action: "quiet-mode",
        operation: "on",
      }).valid,
    ).toBe(true);
    expect(
      validateSchema(quietModeSchema, {
        action: "quiet-mode",
        operation: "toggle",
      }).valid,
    ).toBe(false);
  });

  it("returns fixed confirmation text", async () => {
    await expect(
      quietModeAction.execute(
        { action: "quiet-mode", operation: "on" },
        {},
      ),
    ).resolves.toEqual({ spoken: "Quiet mode on." });
    await expect(
      quietModeAction.execute(
        { action: "quiet-mode", operation: "off" },
        {},
      ),
    ).resolves.toEqual({ spoken: "Quiet mode off." });
  });
});
