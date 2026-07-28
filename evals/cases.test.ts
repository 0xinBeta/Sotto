import { describe, expect, it } from "vitest";

import actions from "../packages/actions/src/index.js";
import { ActionRegistry, validateSchema } from "../packages/core/src/index.js";
import { composeResponseConstraint } from "../packages/nano/src/index.js";
import cases from "./cases.json";

const constraint = composeResponseConstraint(new ActionRegistry(actions));

describe("intent eval schema drift", () => {
  it.each(cases)("$id expected command matches the composed schema", (testCase) => {
    const result = validateSchema(constraint, testCase.expected);

    expect(result.errors, testCase.id).toEqual([]);
    expect(result.valid, testCase.id).toBe(true);
  });

  it.each(["summarize", "ask-page", "type", "notes"] as const)(
    "keeps at least twelve v0.2 cases for %s",
    (actionId) => {
      expect(
        cases.filter((testCase) => testCase.expected.action === actionId)
          .length,
      ).toBeGreaterThanOrEqual(12);
    },
  );

  it("keeps security near-misses on the unknown path", () => {
    const nearMisses = cases.filter((testCase) =>
      testCase.id.startsWith("unknown-") &&
      testCase.id.includes("-near-"),
    );
    expect(nearMisses.length).toBeGreaterThanOrEqual(8);
    expect(
      nearMisses.every(
        (testCase) => testCase.expected.action === "unknown",
      ),
    ).toBe(true);
  });
});
