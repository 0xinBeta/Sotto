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
});
