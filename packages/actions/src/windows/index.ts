import { defineAction } from "@sotto/core";
import type { JsonSchema } from "@sotto/core";

export type WindowOperation =
  | "new"
  | "close"
  | "move-tab"
  | "toggle-fullscreen";

export type WindowsCommand = {
  readonly action: "windows";
  readonly operation: WindowOperation;
};

function operationSchema(operation: WindowOperation): JsonSchema {
  return {
    type: "object",
    properties: {
      action: { const: "windows" },
      operation: { const: operation },
    },
    required: ["action", "operation"],
    additionalProperties: false,
  };
}

export const windowsSchema = {
  oneOf: [
    operationSchema("new"),
    operationSchema("close"),
    operationSchema("move-tab"),
    operationSchema("toggle-fullscreen"),
  ],
} as const satisfies JsonSchema;

async function activeTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  if (tab?.id === undefined) throw new Error("No active tab is available");
  return tab;
}

async function currentWindow(): Promise<chrome.windows.Window> {
  const window = await chrome.windows.getCurrent();
  if (window.id === undefined) {
    throw new Error("No current window is available");
  }
  return window;
}

const windowsAction = defineAction<WindowsCommand>({
  id: "windows",
  title: "Windows",
  permissions: ["tabs"],
  schema: windowsSchema,
  examples: [
    {
      say: "open a new window",
      emit: { action: "windows", operation: "new" },
    },
    {
      say: "close this window",
      emit: { action: "windows", operation: "close" },
    },
    {
      say: "move this tab to a new window",
      emit: { action: "windows", operation: "move-tab" },
    },
    {
      say: "fullscreen",
      emit: { action: "windows", operation: "toggle-fullscreen" },
    },
    {
      say: "exit fullscreen",
      emit: { action: "windows", operation: "toggle-fullscreen" },
    },
  ],
  confirm: (command) =>
    (command as WindowsCommand).operation === "close",
  async execute(command) {
    switch (command.operation) {
      case "new":
        await chrome.windows.create();
        return { spoken: "Opened a new window." };
      case "close": {
        const window = await currentWindow();
        await chrome.windows.remove(window.id!);
        return { spoken: "Closed the window." };
      }
      case "move-tab": {
        const tab = await activeTab();
        await chrome.windows.create({ tabId: tab.id });
        return { spoken: "Moved the tab to a new window." };
      }
      case "toggle-fullscreen": {
        const window = await currentWindow();
        const fullscreen = window.state !== "fullscreen";
        await chrome.windows.update(window.id!, {
          state: fullscreen ? "fullscreen" : "normal",
        });
        return {
          spoken: fullscreen
            ? "Fullscreen is on."
            : "Fullscreen is off.",
        };
      }
    }
  },
});

export default windowsAction;
