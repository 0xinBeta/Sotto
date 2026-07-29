import { describe, expect, it, vi } from "vitest";

import { validateSchema } from "@sotto/core";
import notesAction, { notesSchema } from "../src/notes/index.js";
import {
  MAX_NOTES,
  NOTES_CAP_MESSAGE,
  STORAGE_FULL_MESSAGE,
} from "../src/notes/storage.js";

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
    { action: "notes", operation: "snooze", delayMinutes: 10 },
    { action: "notes", operation: "list-reminders" },
    { action: "notes", operation: "cancel-reminder" },
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
    {
      action: "notes",
      operation: "cancel-reminder",
      text: "Page-derived reminder",
    },
    {
      action: "notes",
      operation: "snooze",
      delayMinutes: 15,
    },
  ])("rejects out-of-contract command data", (command) => {
    expect(validateSchema(notesSchema, command).valid).toBe(false);
  });

  it("requires confirmation for note deletion and reminder cancellation", () => {
    if (typeof notesAction.confirm !== "function") {
      throw new TypeError("Notes confirmation must use the command");
    }
    expect(
      notesAction.confirm({ action: "notes", operation: "delete-last" }),
    ).toBe(true);
    expect(
      notesAction.confirm({
        action: "notes",
        operation: "cancel-reminder",
      }),
    ).toBe(true);
    expect(
      notesAction.confirm({ action: "notes", operation: "read" }),
    ).toBe(false);
  });

  it("returns the note cap refusal as the spoken result", async () => {
    const values = Object.fromEntries(
      Array.from({ length: MAX_NOTES }, (_, index) => {
        const id = `note-${index}`;
        return [
          `note:${id}`,
          {
            id,
            body: `Note ${index}`,
            createdAt: "2026-07-28T12:00:00.000Z",
            updatedAt: "2026-07-28T12:00:00.000Z",
          },
        ];
      }),
    );
    const set = vi.fn();
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: vi.fn(async () => ({ schemaVersion: 1, ...values })),
          set,
          remove: vi.fn(),
        },
      },
    });

    try {
      await expect(
        notesAction.execute({
          action: "notes",
          operation: "create",
          body: "One more note",
        }, {}),
      ).resolves.toEqual({ spoken: NOTES_CAP_MESSAGE });
      expect(set).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("returns a storage quota error as the spoken result", async () => {
    vi.stubGlobal("crypto", {
      randomUUID: vi.fn(() => "quota-note"),
    });
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: vi.fn(async () => ({})),
          set: vi.fn(async () => {
            throw new Error("QUOTA_BYTES quota exceeded");
          }),
          remove: vi.fn(async () => undefined),
        },
      },
    });

    try {
      await expect(
        notesAction.execute({
          action: "notes",
          operation: "create",
          body: "Save this note",
        }, {}),
      ).resolves.toEqual({ spoken: STORAGE_FULL_MESSAGE });
    } finally {
      vi.unstubAllGlobals();
    }
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

  it("reads pending reminders with relative times, soonest first", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T12:00:00.000Z"));
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: vi.fn(async () => ({
            schemaVersion: 1,
            "reminder:later": {
              id: "later",
              text: "Stretch",
              dueAt: "2026-07-28T12:30:00.000Z",
              status: "scheduled",
              alarmName: "reminder:later",
            },
            "reminder:sooner": {
              id: "sooner",
              text: "Check the build",
              dueAt: "2026-07-28T12:12:00.000Z",
              status: "scheduled",
              alarmName: "reminder:sooner",
            },
            "reminder:done": {
              id: "done",
              text: "Old task",
              dueAt: "2026-07-28T12:05:00.000Z",
              status: "delivered",
              alarmName: "reminder:done",
            },
          })),
        },
      },
    });

    try {
      await expect(
        notesAction.execute(
          { action: "notes", operation: "list-reminders" },
          {},
        ),
      ).resolves.toEqual({
        spoken:
          "in 12 minutes: Check the build. in 30 minutes: Stretch",
      });
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});
