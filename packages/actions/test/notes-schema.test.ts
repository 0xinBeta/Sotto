import { describe, expect, it, vi } from "vitest";

import { validateSchema } from "@sotto/core";
import notesAction, { notesSchema } from "../src/notes/index.js";

describe("notes action schema", () => {
  it.each([
    {
      action: "notes",
      operation: "create",
      body: "Save the local benchmark",
    },
    { action: "notes", operation: "list" },
    { action: "notes", operation: "read" },
    { action: "notes", operation: "delete-last" },
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

  it("requires confirmation only for delete-last", () => {
    if (typeof notesAction.confirm !== "function") {
      throw new TypeError("Notes confirmation must use the command");
    }
    expect(
      notesAction.confirm({ action: "notes", operation: "delete-last" }),
    ).toBe(true);
    expect(
      notesAction.confirm({ action: "notes", operation: "read" }),
    ).toBe(false);
  });

  it("returns notes in the long-form speech path, newest first", async () => {
    const older = {
      id: "older",
      body: "Older note",
      createdAt: "2026-07-28T10:00:00.000Z",
      updatedAt: "2026-07-28T10:00:00.000Z",
    };
    const newer = {
      id: "newer",
      body: "Newer note",
      createdAt: "2026-07-28T11:00:00.000Z",
      updatedAt: "2026-07-28T11:00:00.000Z",
    };
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: vi.fn(async () => ({
            schemaVersion: 1,
            "note:older": older,
            "note:newer": newer,
          })),
        },
      },
    });

    try {
      await expect(
        notesAction.execute(
          { action: "notes", operation: "read" },
          {},
        ),
      ).resolves.toEqual({
        spoken: "Reading your notes.",
        pageText: {
          text: "Note 1. Newer note\n\nNote 2. Older note",
          title: "NOTES",
          speech: "long",
        },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
