import { describe, expect, it } from "vitest";

import {
  ActionRegistry,
  validateSchema,
} from "@sotto/core";
import actions, {
  HELP_SUMMARY_MAX_CHARACTERS,
  helpAction,
  helpSchema,
} from "../src/index.js";

describe("help action", () => {
  it("owns strict show and read command schemas", () => {
    expect(
      validateSchema(helpSchema, { action: "help", mode: "show" }),
    ).toEqual({ valid: true, errors: [] });
    expect(
      validateSchema(helpSchema, { action: "help", mode: "read" }),
    ).toEqual({ valid: true, errors: [] });
    expect(validateSchema(helpSchema, { action: "help" }).valid).toBe(false);
    expect(
      validateSchema(helpSchema, {
        action: "help",
        mode: "show",
        text: "untrusted",
      }).valid,
    ).toBe(false);
  });

  it("registers the required example phrasings", () => {
    expect(helpAction.examples).toEqual([
      {
        say: "what can I say",
        emit: { action: "help", mode: "show" },
      },
      {
        say: "help",
        emit: { action: "help", mode: "show" },
      },
      {
        say: "show commands",
        emit: { action: "help", mode: "show" },
      },
      {
        say: "read the commands",
        emit: { action: "help", mode: "read" },
      },
    ]);
  });

  it("keeps the show response short and sends the panel workflow", async () => {
    const actionCatalog = new ActionRegistry(actions);
    const result = await helpAction.execute(
      { action: "help", mode: "show" },
      { actionCatalog },
    );

    expect(result).toEqual({
      spoken: `Sotto supports ${actionCatalog.list().length} commands; open the panel for the list.`,
      workflow: { kind: "panel-command-reference" },
    });
    expect(result.spoken.length).toBeLessThanOrEqual(
      HELP_SUMMARY_MAX_CHARACTERS,
    );
    expect(result.spoken.match(/[.!?]/gu)).toHaveLength(1);
  });

  it("reads grouped registry examples only in read mode", async () => {
    const actionCatalog = new ActionRegistry(actions);
    const shown = await helpAction.execute(
      { action: "help", mode: "show" },
      { actionCatalog },
    );
    const read = await helpAction.execute(
      { action: "help", mode: "read" },
      { actionCatalog },
    );

    expect(shown.spoken).not.toContain("take a screenshot");
    expect(read.spoken).toContain("Screenshot: take a screenshot");
    expect(read.spoken).toContain("Help: what can I say");
  });
});
