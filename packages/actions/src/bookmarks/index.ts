import { defineAction } from "@sotto/core";
import type { JsonSchema } from "@sotto/core";

export type BookmarksCommand = {
  readonly action: "bookmarks";
  readonly operation: "create" | "remove";
};

export interface ActiveTabBookmark {
  readonly id: string;
  readonly title: string;
}

interface ActivePage {
  readonly url: string;
  readonly title?: string;
}

function operationSchema(operation: BookmarksCommand["operation"]): JsonSchema {
  return {
    type: "object",
    properties: {
      action: { const: "bookmarks" },
      operation: { const: operation },
    },
    required: ["action", "operation"],
    additionalProperties: false,
  };
}

export const bookmarksSchema = {
  oneOf: [
    operationSchema("create"),
    operationSchema("remove"),
  ],
} as const satisfies JsonSchema;

async function activePage(): Promise<ActivePage> {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  if (!tab) throw new Error("No active tab is available");

  const url = tab.url?.trim();
  if (!url) throw new Error("The active tab has no URL");

  const title = tab.title?.trim();
  return title ? { url, title } : { url };
}

export async function findActiveTabBookmark(): Promise<
  ActiveTabBookmark | undefined
> {
  const page = await activePage();
  const matches = await chrome.bookmarks.search({ url: page.url });
  const bookmark = matches.find((candidate) => candidate.url === page.url);
  if (!bookmark) return undefined;

  return {
    id: bookmark.id,
    title: page.title ?? (bookmark.title.trim() || "this page"),
  };
}

const bookmarksAction = defineAction<BookmarksCommand>({
  id: "bookmarks",
  title: "Bookmarks",
  permissions: ["bookmarks", "tabs"],
  schema: bookmarksSchema,
  examples: [
    {
      say: "bookmark this page",
      emit: { action: "bookmarks", operation: "create" },
    },
    {
      say: "add this page to my bookmarks",
      emit: { action: "bookmarks", operation: "create" },
    },
    {
      say: "remove this bookmark",
      emit: { action: "bookmarks", operation: "remove" },
    },
    {
      say: "unbookmark this page",
      emit: { action: "bookmarks", operation: "remove" },
    },
  ],
  confirm: (command) =>
    (command as BookmarksCommand).operation === "remove",
  async execute(command) {
    if (command.operation === "create") {
      const page = await activePage();
      await chrome.bookmarks.create({
        url: page.url,
        ...(page.title === undefined ? {} : { title: page.title }),
      });
      return { spoken: "Bookmarked." };
    }

    const bookmark = await findActiveTabBookmark();
    if (!bookmark) return { spoken: "This page has no bookmark." };

    await chrome.bookmarks.remove(bookmark.id);
    return { spoken: "Removed the bookmark." };
  },
});

export default bookmarksAction;
