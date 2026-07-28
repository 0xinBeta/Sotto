import { defineAction } from "@sotto/core";
import type { ActionCommand, JsonSchema } from "@sotto/core";

export type ScreenshotDestination = "copy" | "claude";

export interface ScreenshotCommand extends ActionCommand {
  readonly action: "screenshot";
  readonly destination: ScreenshotDestination;
}

const schema = {
  type: "object",
  properties: {
    action: { const: "screenshot" },
    destination: { type: "string", enum: ["copy", "claude"] },
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
      say: "send a screenshot to my Claude chat",
      emit: { action: "screenshot", destination: "claude" },
    },
  ],
  confirm: false,
  async execute(command, context) {
    if (!context.dispatchDestination) {
      throw new Error(
        "Screenshot requires a destination dispatcher in ActionContext",
      );
    }

    const [activeTab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!activeTab || activeTab.windowId === undefined) {
      throw new Error("No active tab is available to capture");
    }

    const dataUrl = await chrome.tabs.captureVisibleTab(activeTab.windowId, {
      format: "png",
    });
    return context.dispatchDestination(command.destination, {
      kind: "image",
      mimeType: "image/png",
      dataUrl,
    });
  },
});

export default screenshot;
