import { defineAction } from "@sotto/core";
import type { ActionCommand, JsonSchema } from "@sotto/core";

export const EMPTY_REPEAT_RESPONSE = "I have not said anything yet.";

export interface RepeatCommand extends ActionCommand {
  readonly action: "repeat";
}

export const repeatSchema = {
  type: "object",
  properties: {
    action: { const: "repeat" },
  },
  required: ["action"],
  additionalProperties: false,
} as const satisfies JsonSchema;

const repeatAction = defineAction<RepeatCommand>({
  id: "repeat",
  title: "Repeat response",
  permissions: ["tts"],
  schema: repeatSchema,
  examples: [
    {
      say: "say that again",
      emit: { action: "repeat" },
    },
    {
      say: "repeat that",
      emit: { action: "repeat" },
    },
    {
      say: "what did you say",
      emit: { action: "repeat" },
    },
  ],
  confirm: false,
  async execute() {
    return {
      spoken: EMPTY_REPEAT_RESPONSE,
      replayLastSpoken: true,
    };
  },
});

export default repeatAction;
