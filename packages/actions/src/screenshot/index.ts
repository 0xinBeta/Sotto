import { defineAction } from "@sotto/core";
import type { ActionCommand, JsonSchema } from "@sotto/core";

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

function captureOrigin(
  url: string | undefined,
): { host: string } | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    return {
      host: parsed.host,
    };
  } catch {
    return undefined;
  }
}

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

    const [activeTab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!activeTab || activeTab.windowId === undefined) {
      throw new Error("No active tab is available to capture");
    }

    const captureSite = captureOrigin(activeTab.url);
    if (!captureSite) {
      return { spoken: "I can't capture this page." };
    }

    const hasPermission = await chrome.permissions.contains({
      origins: ["<all_urls>"],
    });
    if (!hasPermission) {
      return {
        spoken: `Screenshot access is needed for ${captureSite.host}.`,
        workflow: {
          kind: "screenshot-permission",
          originPattern: "<all_urls>",
          host: captureSite.host,
          pendingCommand: command,
        },
      };
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
