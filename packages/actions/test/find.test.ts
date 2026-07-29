import { validateSchema } from "@sotto/core";
import type { FindActionServices } from "@sotto/core";
import { describe, expect, it, vi } from "vitest";

import findAction, {
  findSchema,
} from "../src/find/index.js";

function services(
  result: Awaited<ReturnType<FindActionServices["run"]>>,
): FindActionServices {
  return {
    run: vi.fn(async () => result),
  };
}

describe("find action schema", () => {
  it.each([
    { action: "find", operation: "search", query: "x" },
    { action: "find", operation: "search", query: "x".repeat(100) },
    { action: "find", operation: "next" },
    { action: "find", operation: "clear" },
  ])("accepts $operation", (command) => {
    expect(validateSchema(findSchema, command).valid).toBe(true);
  });

  it.each([
    { action: "find", operation: "search", query: "" },
    { action: "find", operation: "search", query: "   " },
    { action: "find", operation: "search", query: "x".repeat(101) },
    { action: "find", operation: "search" },
    { action: "find", operation: "next", query: "page text" },
    { action: "find", operation: "clear", query: "page text" },
    { action: "find", operation: "previous" },
  ])("rejects an invalid command", (command) => {
    expect(validateSchema(findSchema, command).valid).toBe(false);
  });
});

describe("find action responses", () => {
  it.each([
    [3, "3 matches."],
    [0, "No matches."],
  ] as const)("speaks the search result for %s matches", async (
    matches,
    spoken,
  ) => {
    const find = services({
      availability: "available",
      matches,
      wrapped: false,
    });

    await expect(
      findAction.execute(
        { action: "find", operation: "search", query: "  pricing  " },
        { find },
      ),
    ).resolves.toEqual({ spoken });
    expect(find.run).toHaveBeenCalledWith({
      operation: "search",
      query: "pricing",
    });
  });

  it("keeps the next result silent until the search wraps", async () => {
    const find = services({
      availability: "available",
      matches: 3,
      wrapped: false,
    });

    await expect(
      findAction.execute(
        { action: "find", operation: "next" },
        { find },
      ),
    ).resolves.toEqual({ spoken: "", silent: true });
  });

  it("speaks when the next result wraps to the first match", async () => {
    const find = services({
      availability: "available",
      matches: 3,
      wrapped: true,
    });

    await expect(
      findAction.execute(
        { action: "find", operation: "next" },
        { find },
      ),
    ).resolves.toEqual({ spoken: "Back to the first match." });
  });

  it("clears the search without speech", async () => {
    const find = services({
      availability: "available",
      matches: 0,
      wrapped: false,
    });

    await expect(
      findAction.execute(
        { action: "find", operation: "clear" },
        { find },
      ),
    ).resolves.toEqual({ spoken: "", silent: true });
    expect(find.run).toHaveBeenCalledWith({ operation: "clear" });
  });

  it.each(["search", "next", "clear"] as const)(
    "reports when %s is unavailable",
    async (operation) => {
      const find = services({ availability: "unavailable" });
      const command = operation === "search"
        ? {
            action: "find" as const,
            operation,
            query: "pricing",
          }
        : { action: "find" as const, operation };

      await expect(
        findAction.execute(command, { find }),
      ).resolves.toEqual({
        spoken: "I cannot search this page.",
      });
    },
  );
});
