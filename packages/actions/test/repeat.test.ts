import { describe, expect, it } from "vitest";

import { validateSchema } from "@sotto/core";
import repeatAction, {
  EMPTY_REPEAT_RESPONSE,
  repeatSchema,
} from "../src/repeat/index.js";

describe("repeat action", () => {
  it("accepts only the repeat command", () => {
    expect(validateSchema(repeatSchema, { action: "repeat" }).valid).toBe(true);
    expect(
      validateSchema(repeatSchema, {
        action: "repeat",
        text: "Do not store this",
      }).valid,
    ).toBe(false);
  });

  it("requests the worker speech replay", async () => {
    await expect(
      repeatAction.execute({ action: "repeat" }, {}),
    ).resolves.toEqual({
      spoken: EMPTY_REPEAT_RESPONSE,
      replayLastSpoken: true,
    });
  });
});
