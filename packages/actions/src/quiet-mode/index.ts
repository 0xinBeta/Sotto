import { defineAction } from "@sotto/core";
import type { ActionCommand, JsonSchema } from "@sotto/core";

export type QuietModeOperation = "on" | "off";

export interface QuietModeCommand extends ActionCommand {
  readonly action: "quiet-mode";
  readonly operation: QuietModeOperation;
}

export const quietModeSchema = {
  type: "object",
  properties: {
    action: { const: "quiet-mode" },
    operation: { type: "string", enum: ["on", "off"] },
  },
  required: ["action", "operation"],
  additionalProperties: false,
} as const satisfies JsonSchema;

const quietModeAction = defineAction<QuietModeCommand>({
  id: "quiet-mode",
  title: "Quiet mode",
  permissions: ["storage", "tts"],
  schema: quietModeSchema,
  examples: [
    {
      say: "do not disturb on",
      emit: { action: "quiet-mode", operation: "on" },
    },
    {
      say: "mute yourself",
      emit: { action: "quiet-mode", operation: "on" },
    },
    {
      say: "do not disturb off",
      emit: { action: "quiet-mode", operation: "off" },
    },
    {
      say: "unmute yourself",
      emit: { action: "quiet-mode", operation: "off" },
    },
  ],
  confirm: false,
  async execute(command) {
    return {
      spoken:
        command.operation === "on"
          ? "Quiet mode on."
          : "Quiet mode off.",
    };
  },
});

export default quietModeAction;
