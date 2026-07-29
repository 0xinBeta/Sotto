import { defineAction } from "@sotto/core";
import type { JsonSchema } from "@sotto/core";
import {
  MAX_NOTE_BODY_LENGTH,
  MAX_REMINDER_DELAY_MINUTES,
  MAX_REMINDER_TEXT_LENGTH,
  MIN_REMINDER_DELAY_MINUTES,
  NotesStorageUserError,
  notesReminderStore,
} from "./storage.js";

export type NotesCommand =
  | {
      readonly action: "notes";
      readonly operation: "create";
      readonly body: string;
    }
  | {
      readonly action: "notes";
      readonly operation: "list";
    }
  | {
      readonly action: "notes";
      readonly operation: "read";
    }
  | {
      readonly action: "notes";
      readonly operation: "delete-last";
    }
  | {
      readonly action: "notes";
      readonly operation: "remind";
      readonly text: string;
      readonly delayMinutes: number;
    }
  | {
      readonly action: "notes";
      readonly operation: "list-reminders" | "cancel-reminder";
    };

export const notesSchema = {
  oneOf: [
    {
      type: "object",
      properties: {
        action: { const: "notes" },
        operation: { const: "create" },
        body: {
          type: "string",
          minLength: 1,
          maxLength: MAX_NOTE_BODY_LENGTH,
          description: "The note text copied only from the transcript",
        },
      },
      required: ["action", "operation", "body"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        action: { const: "notes" },
        operation: { const: "list" },
      },
      required: ["action", "operation"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        action: { const: "notes" },
        operation: { const: "read" },
      },
      required: ["action", "operation"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        action: { const: "notes" },
        operation: { const: "delete-last" },
      },
      required: ["action", "operation"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        action: { const: "notes" },
        operation: { const: "remind" },
        text: {
          type: "string",
          minLength: 1,
          maxLength: MAX_REMINDER_TEXT_LENGTH,
          description: "The reminder text copied only from the transcript",
        },
        delayMinutes: {
          type: "number",
          minimum: MIN_REMINDER_DELAY_MINUTES,
          maximum: MAX_REMINDER_DELAY_MINUTES,
          description: "Bounded delay in minutes parsed from the transcript",
        },
      },
      required: ["action", "operation", "text", "delayMinutes"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        action: { const: "notes" },
        operation: { const: "list-reminders" },
      },
      required: ["action", "operation"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        action: { const: "notes" },
        operation: { const: "cancel-reminder" },
      },
      required: ["action", "operation"],
      additionalProperties: false,
    },
  ],
} as const satisfies JsonSchema;

export function formatReminderTime(
  dueAt: string,
  now = Date.now(),
): string {
  const remainingMs = Date.parse(dueAt) - now;
  if (remainingMs <= 0) return "now";

  const minutes = Math.max(1, Math.round(remainingMs / 60_000));
  if (minutes < 60) {
    return `in ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  }

  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `in ${hours} ${hours === 1 ? "hour" : "hours"}`;
  }

  const days = Math.round(hours / 24);
  return `in ${days} ${days === 1 ? "day" : "days"}`;
}

const notesAction = defineAction<NotesCommand>({
  id: "notes",
  title: "Notes and reminders",
  permissions: ["storage", "alarms", "notifications"],
  schema: notesSchema,
  examples: [
    {
      say: "note that down: check the benchmark",
      emit: {
        action: "notes",
        operation: "create",
        body: "Check the benchmark",
      },
    },
    {
      say: "make a note to compare local speech models",
      emit: {
        action: "notes",
        operation: "create",
        body: "Compare local speech models",
      },
    },
    {
      say: "show my notes",
      emit: { action: "notes", operation: "list" },
    },
    {
      say: "read my notes",
      emit: { action: "notes", operation: "read" },
    },
    {
      say: "delete my last note",
      emit: { action: "notes", operation: "delete-last" },
    },
    {
      say: "remind me to stretch in thirty seconds",
      emit: {
        action: "notes",
        operation: "remind",
        text: "Stretch",
        delayMinutes: 0.5,
      },
    },
    {
      say: "remind me to check the oven in ten minutes",
      emit: {
        action: "notes",
        operation: "remind",
        text: "Check the oven",
        delayMinutes: 10,
      },
    },
    {
      say: "remind me in twenty minutes to check the build",
      emit: {
        action: "notes",
        operation: "remind",
        text: "Check the build",
        delayMinutes: 20,
      },
    },
    {
      say: "what are my reminders",
      emit: { action: "notes", operation: "list-reminders" },
    },
    {
      say: "cancel my reminder",
      emit: { action: "notes", operation: "cancel-reminder" },
    },
  ],
  confirm: (command) =>
    (command as NotesCommand).operation === "delete-last" ||
    (command as NotesCommand).operation === "cancel-reminder",
  async execute(command) {
    try {
      switch (command.operation) {
        case "create": {
          const note = await notesReminderStore.createNote({
            body: command.body,
          });
          return {
            spoken: "Saved your note.",
            data: {
              note: {
                id: note.id,
                body: note.body,
                createdAt: note.createdAt,
                updatedAt: note.updatedAt,
              },
            },
          };
        }
        case "list": {
          const notes = await notesReminderStore.listNotes();
          return {
            spoken:
              notes.length === 0
                ? "You have no notes."
                : `You have ${notes.length} ${notes.length === 1 ? "note" : "notes"}.`,
            data: {
              notes: notes.map((note) => ({
                id: note.id,
                body: note.body,
                createdAt: note.createdAt,
                updatedAt: note.updatedAt,
                ...(note.source ? { source: { ...note.source } } : {}),
              })),
            },
          };
        }
        case "read": {
          const notes = await notesReminderStore.listNotes();
          if (notes.length === 0) {
            return { spoken: "You have no notes." };
          }
          return {
            spoken: "Reading your notes.",
            pageText: {
              text: notes
                .map((note, index) => `Note ${index + 1}. ${note.body}`)
                .join("\n\n"),
              title: "NOTES",
              speech: "long",
            },
          };
        }
        case "delete-last": {
          const note = await notesReminderStore.deleteLastNote();
          return {
            spoken: note ? "Deleted the note." : "You have no notes.",
          };
        }
        case "remind": {
          const [activeTab] = await chrome.tabs.query({
            active: true,
            currentWindow: true,
          });
          const reminder = await notesReminderStore.scheduleReminder({
            text: command.text,
            delayMinutes: command.delayMinutes,
            ...(activeTab?.id === undefined
              ? {}
              : { sourceTabId: activeTab.id }),
            ...(activeTab?.windowId === undefined
              ? {}
              : { sourceWindowId: activeTab.windowId }),
          });
          return {
            spoken: "Set your reminder.",
            data: {
              reminder: {
                id: reminder.id,
                text: reminder.text,
                dueAt: reminder.dueAt,
                status: reminder.status,
                alarmName: reminder.alarmName,
              },
            },
          };
        }
        case "list-reminders": {
          const reminders = await notesReminderStore.listPendingReminders();
          return {
            spoken: reminders.length === 0
              ? "You have no pending reminders."
              : reminders
                .map((reminder) =>
                  `${formatReminderTime(reminder.dueAt)}: ${reminder.text}`
                )
                .join(". "),
          };
        }
        case "cancel-reminder": {
          const reminders = await notesReminderStore.listPendingReminders();
          const reminder = reminders[0];
          if (!reminder) {
            return { spoken: "You have no pending reminders." };
          }
          if (reminders.length > 1) {
            return { spoken: "Which reminder do you want to cancel?" };
          }
          const cancelled = await notesReminderStore.cancelReminder(reminder.id);
          return {
            spoken: cancelled
              ? "Cancelled the reminder."
              : "That reminder is no longer pending.",
          };
        }
      }
    } catch (error) {
      if (error instanceof NotesStorageUserError) {
        return { spoken: error.message };
      }
      throw error;
    }
  },
});

export default notesAction;
export * from "./markdown.js";
export * from "./storage.js";
