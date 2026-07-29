import actions from "@sotto/actions";
import { ActionRegistry } from "@sotto/core";
import {
  buildActionParserPrompt,
  buildParserInitialPrompts,
  composeActionConstraint,
  composeActionSelectionConstraint,
  composeResponseConstraint,
} from "@sotto/nano";
import { describe, expect, it } from "vitest";

function messageContentCharacters(
  messages: readonly LanguageModelMessage[],
): number {
  return messages.reduce(
    (total, message) =>
      total +
      (typeof message.content === "string"
        ? message.content.length
        : JSON.stringify(message.content).length),
    0,
  );
}

describe("production parser constraint size", () => {
  it("reports full and two-stage parser sizes", () => {
    const registry = new ActionRegistry(actions);
    const fullConstraintCharacters = JSON.stringify(
      composeResponseConstraint(registry),
    ).length;
    const stage1ConstraintCharacters = JSON.stringify(
      composeActionSelectionConstraint(registry),
    ).length;
    const initialPrompts = buildParserInitialPrompts(registry);
    const initialPromptCharacters = messageContentCharacters(initialPrompts);
    const stage2Sizes = registry.list().map((action) => ({
      action: action.id,
      constraintCharacters: JSON.stringify(
        composeActionConstraint(action),
      ).length,
      promptCharacters: messageContentCharacters(
        buildActionParserPrompt(action, "measure this transcript"),
      ),
    }));
    const largestStage2Constraint = stage2Sizes.reduce((largest, current) =>
      current.constraintCharacters > largest.constraintCharacters
        ? current
        : largest
    );
    const largestStage2Prompt = stage2Sizes.reduce((largest, current) =>
      current.promptCharacters > largest.promptCharacters
        ? current
        : largest
    );

    console.info(
      [
        "[parser-size]",
        `actions=${registry.list().length}`,
        `full-constraint=${fullConstraintCharacters} chars`,
        `stage-1-constraint=${stage1ConstraintCharacters} chars`,
        `stage-1-initial-prompt=${initialPromptCharacters} chars`,
        `largest-stage-2-constraint=${largestStage2Constraint.action}:${
          largestStage2Constraint.constraintCharacters
        } chars`,
        `largest-stage-2-prompt=${largestStage2Prompt.action}:${
          largestStage2Prompt.promptCharacters
        } chars`,
      ].join(" "),
    );

    const selectionExampleCount = registry.list().reduce(
      (total, action) => total + Math.min(2, action.examples.length),
      0,
    );
    expect(initialPrompts).toHaveLength(1 + selectionExampleCount * 2);
    expect(stage1ConstraintCharacters).toBeLessThan(
      fullConstraintCharacters,
    );
    expect(largestStage2Constraint.constraintCharacters).toBeLessThan(
      fullConstraintCharacters,
    );
  });
});
