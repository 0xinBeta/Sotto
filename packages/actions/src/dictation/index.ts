import { defineAction } from "@sotto/core";
import type { ActionContext, DictationActionServices } from "@sotto/core";

export type DictationOperation = "start" | "stop";

export interface DictationCommand {
  readonly action: "dictation";
  readonly operation: DictationOperation;
}

export const dictationSchema = {
  type: "object",
  properties: {
    action: { const: "dictation" },
    operation: { type: "string", enum: ["start", "stop"] },
  },
  required: ["action", "operation"],
  additionalProperties: false,
} as const;

function servicesFrom(context: ActionContext): DictationActionServices {
  if (!context.dictation) {
    throw new Error("Dictation requires editor services in ActionContext");
  }
  return context.dictation;
}

const dictation = defineAction<DictationCommand>({
  id: "dictation",
  title: "Dictation",
  permissions: ["activeTab", "scripting"],
  schema: dictationSchema,
  examples: [
    {
      say: "start dictation",
      emit: { action: "dictation", operation: "start" },
    },
    {
      say: "begin dictation",
      emit: { action: "dictation", operation: "start" },
    },
    {
      say: "turn on dictation",
      emit: { action: "dictation", operation: "start" },
    },
    {
      say: "stop dictation",
      emit: { action: "dictation", operation: "stop" },
    },
    {
      say: "end dictation",
      emit: { action: "dictation", operation: "stop" },
    },
    {
      say: "exit dictation",
      emit: { action: "dictation", operation: "stop" },
    },
  ],
  confirm: false,
  async execute(command, context) {
    const services = servicesFrom(context);
    const spoken = command.operation === "start"
      ? await services.start()
      : await services.stop();
    return { spoken, silent: true };
  },
});

export default dictation;
