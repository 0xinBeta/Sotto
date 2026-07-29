import { defineAction } from "@sotto/core";
import type { JsonSchema } from "@sotto/core";

export const MAX_TAB_GROUP_TITLE_LENGTH = 40;

export type TabGroupOperation = "group" | "ungroup" | "collapse" | "expand";
export type TabGroupScope = "current" | "highlighted";

export type TabGroupsCommand =
  | {
      readonly action: "tab-groups";
      readonly operation: "group";
      readonly title: string;
    }
  | {
      readonly action: "tab-groups";
      readonly operation: "ungroup";
      readonly scope: TabGroupScope;
    }
  | {
      readonly action: "tab-groups";
      readonly operation: "collapse" | "expand";
    };

function operationSchema(
  operation: "collapse" | "expand",
): JsonSchema {
  return {
    type: "object",
    properties: {
      action: { const: "tab-groups" },
      operation: { const: operation },
    },
    required: ["action", "operation"],
    additionalProperties: false,
  };
}

export const tabGroupsSchema = {
  oneOf: [
    {
      type: "object",
      properties: {
        action: { const: "tab-groups" },
        operation: { const: "group" },
        title: {
          type: "string",
          minLength: 1,
          maxLength: MAX_TAB_GROUP_TITLE_LENGTH,
          pattern: "\\S",
          description:
            "A tab group title copied only from the current transcript",
        },
      },
      required: ["action", "operation", "title"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        action: { const: "tab-groups" },
        operation: { const: "ungroup" },
        scope: { enum: ["current", "highlighted"] },
      },
      required: ["action", "operation", "scope"],
      additionalProperties: false,
    },
    operationSchema("collapse"),
    operationSchema("expand"),
  ],
} as const satisfies JsonSchema;

function tabIds(
  tabs: readonly chrome.tabs.Tab[],
): [number, ...number[]] | undefined {
  const ids = tabs.flatMap((tab) =>
    tab.id === undefined ? [] : [tab.id]
  );
  const [first, ...rest] = ids;
  return first === undefined ? undefined : [first, ...rest];
}

async function activeTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) throw new Error("No active tab is available");
  return tab;
}

async function highlightedTabIds(): Promise<[number, ...number[]]> {
  const highlighted = tabIds(
    await chrome.tabs.query({ highlighted: true, currentWindow: true }),
  );
  if (highlighted) return highlighted;
  return [(await activeTab()).id!];
}

function boundedTitle(title: string): string {
  const bounded = title.trim().slice(0, MAX_TAB_GROUP_TITLE_LENGTH);
  if (!bounded) throw new Error("A tab group title is required");
  return bounded;
}

async function setAllGroupsCollapsed(collapsed: boolean): Promise<number> {
  const windowId = (await activeTab()).windowId;
  const groups = await chrome.tabGroups.query({ windowId });
  await Promise.all(
    groups.map((group) =>
      chrome.tabGroups.update(group.id, { collapsed })
    ),
  );
  return groups.length;
}

const tabGroupsAction = defineAction<TabGroupsCommand>({
  id: "tab-groups",
  title: "Tab groups",
  permissions: ["tabs", "tabGroups"],
  schema: tabGroupsSchema,
  examples: [
    {
      say: "group these tabs as research",
      emit: { action: "tab-groups", operation: "group", title: "research" },
    },
    {
      say: "ungroup this tab",
      emit: {
        action: "tab-groups",
        operation: "ungroup",
        scope: "current",
      },
    },
    {
      say: "ungroup these tabs",
      emit: {
        action: "tab-groups",
        operation: "ungroup",
        scope: "highlighted",
      },
    },
    {
      say: "collapse my groups",
      emit: { action: "tab-groups", operation: "collapse" },
    },
    {
      say: "expand my groups",
      emit: { action: "tab-groups", operation: "expand" },
    },
  ],
  confirm: false,
  async execute(command) {
    switch (command.operation) {
      case "group": {
        const title = boundedTitle(command.title);
        const groupId = await chrome.tabs.group({
          tabIds: await highlightedTabIds(),
        });
        await chrome.tabGroups.update(groupId, { title });
        return { spoken: `Grouped as ${title}.` };
      }
      case "ungroup": {
        const ids = command.scope === "current"
          ? [(await activeTab()).id!] as [number]
          : await highlightedTabIds();
        await chrome.tabs.ungroup(ids);
        return {
          spoken: ids.length === 1
            ? "Ungrouped the tab."
            : "Ungrouped the tabs.",
        };
      }
      case "collapse":
      case "expand": {
        const collapsed = command.operation === "collapse";
        const groupCount = await setAllGroupsCollapsed(collapsed);
        if (groupCount === 0) return { spoken: "You have no tab groups." };
        return {
          spoken: collapsed
            ? "Collapsed your groups."
            : "Expanded your groups.",
        };
      }
    }
  },
});

export default tabGroupsAction;
