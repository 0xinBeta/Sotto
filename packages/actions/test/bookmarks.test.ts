import {
  ActionRegistry,
  CommandRouter,
  CommandValidationError,
  validateSchema,
} from "@sotto/core";
import { beforeEach, describe, expect, it } from "vitest";

import bookmarksAction from "../src/bookmarks/index.js";
import { chromeTab, installChromeStub } from "./chrome-stub.js";

describe("bookmarks action", () => {
  let chromeStub: ReturnType<typeof installChromeStub>;

  beforeEach(() => {
    chromeStub = installChromeStub();
  });

  it("creates a bookmark in the default folder for the active tab", async () => {
    chromeStub.tabs.query.mockResolvedValue([
      chromeTab({
        id: 7,
        windowId: 2,
        title: "Local article",
        url: "https://example.test/article",
      }),
    ]);

    await expect(
      bookmarksAction.execute(
        { action: "bookmarks", operation: "create" },
        {},
      ),
    ).resolves.toEqual({ spoken: "Bookmarked." });

    expect(chromeStub.tabs.query).toHaveBeenCalledWith({
      active: true,
      currentWindow: true,
    });
    expect(chromeStub.bookmarks.create).toHaveBeenCalledWith({
      title: "Local article",
      url: "https://example.test/article",
    });
  });

  it("removes the bookmark that matches the active tab URL", async () => {
    chromeStub.tabs.query.mockResolvedValue([
      chromeTab({
        id: 7,
        windowId: 2,
        title: "Local article",
        url: "https://example.test/article",
      }),
    ]);
    chromeStub.bookmarks.search.mockResolvedValue([
      {
        id: "folder",
        syncing: false,
        title: "Article folder",
      },
      {
        id: "bookmark-7",
        syncing: false,
        title: "Saved article",
        url: "https://example.test/article",
      },
    ]);

    await expect(
      bookmarksAction.execute(
        { action: "bookmarks", operation: "remove" },
        {},
      ),
    ).resolves.toEqual({ spoken: "Removed the bookmark." });

    expect(chromeStub.bookmarks.search).toHaveBeenCalledWith({
      url: "https://example.test/article",
    });
    expect(chromeStub.bookmarks.remove).toHaveBeenCalledWith("bookmark-7");
  });

  it("reports when the active page has no bookmark", async () => {
    chromeStub.tabs.query.mockResolvedValue([
      chromeTab({
        id: 7,
        windowId: 2,
        title: "Local article",
        url: "https://example.test/article",
      }),
    ]);
    chromeStub.bookmarks.search.mockResolvedValue([]);

    await expect(
      bookmarksAction.execute(
        { action: "bookmarks", operation: "remove" },
        {},
      ),
    ).resolves.toEqual({ spoken: "This page has no bookmark." });
    expect(chromeStub.bookmarks.remove).not.toHaveBeenCalled();
  });

  it("fails before a bookmark API call when the active tab has no URL", async () => {
    chromeStub.tabs.query.mockResolvedValue([
      chromeTab({ id: 7, windowId: 2, title: "Local article" }),
    ]);

    await expect(
      bookmarksAction.execute(
        { action: "bookmarks", operation: "create" },
        {},
      ),
    ).rejects.toThrow("The active tab has no URL");
    expect(chromeStub.bookmarks.create).not.toHaveBeenCalled();
    expect(chromeStub.bookmarks.search).not.toHaveBeenCalled();
  });

  it("uses the confirm tier only for removal", async () => {
    const router = new CommandRouter(
      new ActionRegistry([bookmarksAction]),
    );
    const create = { action: "bookmarks", operation: "create" } as const;
    const remove = { action: "bookmarks", operation: "remove" } as const;

    expect(router.requiresConfirmation(create)).toBe(false);
    expect(router.requiresConfirmation(remove)).toBe(true);
    await expect(router.route(remove)).rejects.toThrow(
      CommandValidationError,
    );
  });

  it("does not accept a URL or title from the intent parser", () => {
    expect(
      validateSchema(bookmarksAction.schema, {
        action: "bookmarks",
        operation: "create",
      }).valid,
    ).toBe(true);
    expect(
      validateSchema(bookmarksAction.schema, {
        action: "bookmarks",
        operation: "create",
        url: "https://page-derived.test",
      }).valid,
    ).toBe(false);
    expect(
      validateSchema(bookmarksAction.schema, {
        action: "bookmarks",
        operation: "remove",
        title: "Page title",
      }).valid,
    ).toBe(false);
  });
});
