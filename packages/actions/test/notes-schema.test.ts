import { describe, expect, it } from "vitest";

import { validateSchema } from "@sotto/core";
import { notesSchema } from "../src/notes/index.js";

describe("notes action schema", () => {
  it.each([
    {
      action: "notes",
      operation: "create",
      body: "Save the local benchmark",
    },
    { action: "notes", operation: "list" },
    {
      action: "notes",
      operation: "remind",
      text: "Stretch",
      delayMinutes: 0.5,
    },
  ])("accepts a valid command", (command) => {
    expect(validateSchema(notesSchema, command)).toEqual({
      valid: true,
      errors: [],
    });
  });

  it.each([
    {
      action: "notes",
      operation: "remind",
      text: "Too soon",
      delayMinutes: 0.49,
    },
    {
      action: "notes",
      operation: "create",
      body: "Okay",
      pageText: "must never enter notes",
    },
    {
      action: "notes",
      operation: "list",
      delayMinutes: 5,
    },
  ])("rejects out-of-contract command data", (command) => {
    expect(validateSchema(notesSchema, command).valid).toBe(false);
  });
});

