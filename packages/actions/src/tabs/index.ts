import { defineAction } from "@sotto/core";
import type { JsonSchema } from "@sotto/core";
import { findBestTabMatch } from "./match.js";

export type TabOperation =
  | "new"
  | "close"
  | "switch"
  | "mute"
  | "unmute"
  | "reopen";

export type TabsCommand =
  | {
      readonly action: "tabs";
      readonly operation: "new" | "close" | "reopen";
    }
  | {
      readonly action: "tabs";
      readonly operation: "switch";
      readonly tabId: number;
    }
  | {
      readonly action: "tabs";
      readonly operation: "mute" | "unmute";
      readonly tabId?: number;
    };

const tabIdSchema = {
  type: "integer",
  minimum: 0,
  description: "The id of a tab selected from the open-tab parser context",
} as const satisfies JsonSchema;

function operationSchema(
  operation: TabOperation,
  tabId: "forbidden" | "optional" | "required" = "forbidden",
): JsonSchema {
  return {
    type: "object",
    properties: {
      action: { const: "tabs" },
      operation: { const: operation },
      ...(tabId === "forbidden" ? {} : { tabId: tabIdSchema }),
    },
    required:
      tabId === "required"
        ? ["action", "operation", "tabId"]
        : ["action", "operation"],
    additionalProperties: false,
  };
}

const schema = {
  oneOf: [
    operationSchema("new"),
    operationSchema("close"),
    operationSchema("switch", "required"),
    operationSchema("mute", "optional"),
    operationSchema("unmute", "optional"),
    operationSchema("reopen"),
  ],
} as const satisfies JsonSchema;

async function activeTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) throw new Error("No active tab is available");
  return tab;
}

async function getTargetTab(tabId?: number): Promise<chrome.tabs.Tab> {
  if (tabId === undefined) return activeTab();
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    throw new Error(`Tab ${tabId} is no longer open`);
  }
}

async function focusTab(tabId: number): Promise<chrome.tabs.Tab> {
  const tab = await getTargetTab(tabId);
  await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  return tab;
}

async function reopenLastTab(): Promise<void> {
  const recentlyClosed = await chrome.sessions.getRecentlyClosed({
    maxResults: 10,
  });
  const restorable = recentlyClosed.find((session) => session.tab);
  if (!restorable?.tab?.sessionId) {
    throw new Error("There is no recently closed tab to reopen");
  }
  await chrome.sessions.restore(restorable.tab.sessionId);
}

/**
 * Use this before prompting Nano when a raw voice target must be resolved to
 * the canonical tabs command. The selected id can then be included in the
 * constrained command as `{ action: "tabs", operation: "switch", tabId }`.
 */
export function matchTabTarget(
  tabs: readonly chrome.tabs.Tab[],
  target: string,
): chrome.tabs.Tab | undefined {
  return findBestTabMatch(tabs, target);
}

const tabsAction = defineAction<TabsCommand>({
  id: "tabs",
  title: "Tabs",
  permissions: ["tabs", "sessions"],
  schema,
  examples: [
    { say: "open a new tab", emit: { action: "tabs", operation: "new" } },
    { say: "close this tab", emit: { action: "tabs", operation: "close" } },
    {
      say: "switch to the matched GitHub tab with id 42",
      emit: { action: "tabs", operation: "switch", tabId: 42 },
    },
    { say: "mute that video", emit: { action: "tabs", operation: "mute" } },
    {
      say: "unmute this tab",
      emit: { action: "tabs", operation: "unmute" },
    },
    {
      say: "reopen what I just closed",
      emit: { action: "tabs", operation: "reopen" },
    },
  ],
  confirm: false,
  async execute(command) {
    switch (command.operation) {
      case "new":
        await chrome.tabs.create({ active: true });
        return { spoken: "Opened a new tab." };
      case "close": {
        const tab = await activeTab();
        await chrome.tabs.remove(tab.id!);
        return { spoken: "Closed the tab." };
      }
      case "switch": {
        const tab = await focusTab(command.tabId);
        return { spoken: `Switched to ${tab.title || "the tab"}.` };
      }
      case "mute":
      case "unmute": {
        const tab = await getTargetTab(command.tabId);
        const muted = command.operation === "mute";
        await chrome.tabs.update(tab.id!, { muted });
        return {
          spoken: `${muted ? "Muted" : "Unmuted"} ${tab.title || "the tab"}.`,
        };
      }
      case "reopen":
        await reopenLastTab();
        return { spoken: "Reopened the last closed tab." };
    }
  },
});

export default tabsAction;
export { findBestTabMatch, scoreTabMatch } from "./match.js";
