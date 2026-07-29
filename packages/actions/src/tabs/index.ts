import { defineAction } from "@sotto/core";
import type { JsonSchema } from "@sotto/core";
import { findBestTabMatch } from "./match.js";

export type TabOperation =
  | "new"
  | "close"
  | "count"
  | "switch"
  | "mute"
  | "unmute"
  | "reopen";

export type TabsCommand =
  | {
      readonly action: "tabs";
      readonly operation: "new" | "close" | "count" | "reopen";
    }
  | {
      readonly action: "tabs";
      readonly operation: "switch";
      readonly target: string;
      readonly correction?: true;
    }
  | {
      readonly action: "tabs";
      readonly operation: "mute" | "unmute";
    };

function operationSchema(operation: TabOperation): JsonSchema {
  return {
    type: "object",
    properties: {
      action: { const: "tabs" },
      operation: { const: operation },
    },
    required: ["action", "operation"],
    additionalProperties: false,
  };
}

const schema = {
  oneOf: [
    operationSchema("new"),
    operationSchema("close"),
    operationSchema("count"),
    {
      type: "object",
      properties: {
        action: { const: "tabs" },
        operation: { const: "switch" },
        target: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description: "A concise tab target copied only from the transcript",
        },
        correction: { const: true },
      },
      required: ["action", "operation", "target"],
      additionalProperties: false,
    },
    operationSchema("mute"),
    operationSchema("unmute"),
    operationSchema("reopen"),
  ],
} as const satisfies JsonSchema;

async function activeTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) throw new Error("No active tab is available");
  return tab;
}

async function getTab(tabId: number): Promise<chrome.tabs.Tab> {
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    throw new Error(`Tab ${tabId} is no longer open`);
  }
}

async function focusTab(tabId: number): Promise<chrome.tabs.Tab> {
  const tab = await getTab(tabId);
  await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  return tab;
}

async function reopenLastTab(): Promise<void> {
  const recentlyClosed = await chrome.sessions.getRecentlyClosed({
    maxResults: 10,
  });
  const restorable = recentlyClosed.find((session) => session.tab?.sessionId);
  if (!restorable?.tab?.sessionId) {
    throw new Error("There is no recently closed tab to reopen");
  }
  await chrome.sessions.restore(restorable.tab.sessionId);
}

export function matchTabTarget(
  tabs: readonly chrome.tabs.Tab[],
  target: string,
  excludedTabId?: number,
): chrome.tabs.Tab | undefined {
  return findBestTabMatch(tabs, target, 0.42, excludedTabId);
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
      say: "how many tabs are open",
      emit: { action: "tabs", operation: "count" },
    },
    {
      say: "how many tabs do I have",
      emit: { action: "tabs", operation: "count" },
    },
    {
      say: "switch to the GitHub tab",
      emit: { action: "tabs", operation: "switch", target: "GitHub" },
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
      case "count": {
        const tabs = await chrome.tabs.query({});
        return {
          spoken: `You have ${tabs.length} ${tabs.length === 1 ? "tab" : "tabs"} open.`,
        };
      }
      case "switch": {
        const excludedTabId = command.correction
          ? (await activeTab()).id
          : undefined;
        const tabs = await chrome.tabs.query({});
        const matched = matchTabTarget(
          tabs,
          command.target,
          excludedTabId,
        );
        if (matched?.id === undefined) {
          throw new Error(`No open tab matches "${command.target}"`);
        }
        const tab = await focusTab(matched.id);
        return { spoken: `Switched to ${tab.title || "the tab"}.` };
      }
      case "mute":
      case "unmute": {
        const tab = await activeTab();
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
export {
  findBestTabMatch,
  scoreFuzzyMatch,
  scoreTabMatch,
} from "./match.js";
