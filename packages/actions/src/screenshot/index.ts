import { defineAction } from "@sotto/core";
import type { ActionCommand, JsonSchema } from "@sotto/core";
import { captureVisiblePng } from "./capture.js";

export type ScreenshotDestination =
  | "copy"
  | "save"
  | "claude"
  | "chatgpt"
  | "gemini";

export interface ScreenshotCommand extends ActionCommand {
  readonly action: "screenshot";
  readonly destination: ScreenshotDestination;
}

const schema = {
  type: "object",
  properties: {
    action: { const: "screenshot" },
    destination: {
      type: "string",
      enum: ["copy", "save", "claude", "chatgpt", "gemini"],
    },
  },
  required: ["action", "destination"],
  additionalProperties: false,
} as const satisfies JsonSchema;

const screenshot = defineAction<ScreenshotCommand>({
  id: "screenshot",
  title: "Screenshot",
  permissions: ["activeTab"],
  schema,
  examples: [
    {
      say: "take a screenshot",
      emit: { action: "screenshot", destination: "copy" },
    },
    {
      say: "take a screenshot and save it",
      emit: { action: "screenshot", destination: "save" },
    },
    {
      say: "save a screenshot",
      emit: { action: "screenshot", destination: "save" },
    },
    {
      say: "send a screenshot to my Claude chat",
      emit: { action: "screenshot", destination: "claude" },
    },
    {
      say: "take a screenshot and send it to ChatGPT",
      emit: { action: "screenshot", destination: "chatgpt" },
    },
    {
      say: "send a screenshot to my Gemini chat",
      emit: { action: "screenshot", destination: "gemini" },
    },
  ],
  confirm: false,
  async execute(command, context) {
    if (!context.dispatchDestination) {
      throw new Error(
        "Screenshot requires a destination dispatcher in ActionContext",
      );
    }

    const capture = await captureVisiblePng(command, "Screenshot");
    if (!capture.ok) return capture.result;
    return context.dispatchDestination(command.destination, {
      kind: "image",
      mimeType: "image/png",
      dataUrl: capture.dataUrl,
    });
  },
});

export default screenshot;
