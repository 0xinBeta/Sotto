import { validateSchema } from "@sotto/core";
import { beforeEach, describe, expect, it } from "vitest";

import tabsAction from "../src/tabs/index.js";
import { chromeTab, installChromeStub } from "./chrome-stub.js";

describe("tabs action", () => {
  let chromeStub: ReturnType<typeof installChromeStub>;

  beforeEach(() => {
    chromeStub = installChromeStub();
  });

  it("creates an active tab", async () => {
    await expect(
      tabsAction.execute({ action: "tabs", operation: "new" }, {}),
    ).resolves.toEqual({ spoken: "Opened a new tab." });
    expect(chromeStub.tabs.create).toHaveBeenCalledWith({ active: true });
  });

  it("closes the active tab", async () => {
    chromeStub.tabs.query.mockResolvedValue([
      chromeTab({ id: 9, windowId: 2 }),
    ]);

    await expect(
      tabsAction.execute({ action: "tabs", operation: "close" }, {}),
    ).resolves.toEqual({ spoken: "Closed the tab." });

    expect(chromeStub.tabs.query).toHaveBeenCalledWith({
      active: true,
      currentWindow: true,
    });
    expect(chromeStub.tabs.remove).toHaveBeenCalledWith(9);
  });

  it("reports when an operation requiring the active tab has none", async () => {
    chromeStub.tabs.query.mockResolvedValue([]);

    await expect(
      tabsAction.execute({ action: "tabs", operation: "close" }, {}),
    ).rejects.toThrow("No active tab is available");
    expect(chromeStub.tabs.remove).not.toHaveBeenCalled();
  });

  it.each([
    [1, "You have 1 tab open."],
    [4, "You have 4 tabs open."],
  ] as const)("counts %i open tabs", async (count, spoken) => {
    chromeStub.tabs.query.mockResolvedValue(
      Array.from({ length: count }, (_, index) =>
        chromeTab({ id: index + 1, windowId: 1 }),
      ),
    );

    await expect(
      tabsAction.execute({ action: "tabs", operation: "count" }, {}),
    ).resolves.toEqual({ spoken });
    expect(chromeStub.tabs.query).toHaveBeenCalledWith({});
  });

  it("switches tabs and focuses the containing window", async () => {
    chromeStub.tabs.query.mockResolvedValue([
      chromeTab({ id: 42, windowId: 5, title: "GitHub" }),
    ]);
    chromeStub.tabs.get.mockResolvedValue(
      chromeTab({ id: 42, windowId: 5, title: "GitHub" }),
    );

    await expect(
      tabsAction.execute(
        { action: "tabs", operation: "switch", target: "GitHub" },
        {},
      ),
    ).resolves.toEqual({ spoken: "Switched to GitHub." });

    expect(chromeStub.tabs.update).toHaveBeenCalledWith(42, { active: true });
    expect(chromeStub.windows.update).toHaveBeenCalledWith(5, {
      focused: true,
    });
  });

  it("excludes the active tab for a switch correction", async () => {
    chromeStub.tabs.query
      .mockResolvedValueOnce([
        chromeTab({ id: 41, windowId: 5, title: "GitHub · First" }),
      ])
      .mockResolvedValueOnce([
        chromeTab({ id: 41, windowId: 5, title: "GitHub · First" }),
        chromeTab({ id: 42, windowId: 6, title: "GitHub · Second" }),
      ]);
    chromeStub.tabs.get.mockResolvedValue(
      chromeTab({ id: 42, windowId: 6, title: "GitHub · Second" }),
    );

    await expect(
      tabsAction.execute(
        {
          action: "tabs",
          operation: "switch",
          target: "GitHub",
          correction: true,
        },
        {},
      ),
    ).resolves.toEqual({ spoken: "Switched to GitHub · Second." });

    expect(chromeStub.tabs.query).toHaveBeenNthCalledWith(1, {
      active: true,
      currentWindow: true,
    });
    expect(chromeStub.tabs.query).toHaveBeenNthCalledWith(2, {});
    expect(chromeStub.tabs.update).toHaveBeenCalledWith(42, { active: true });
    expect(chromeStub.windows.update).toHaveBeenCalledWith(6, {
      focused: true,
    });
  });

  it("accepts only a true correction on a tab switch", () => {
    expect(
      validateSchema(tabsAction.schema, {
        action: "tabs",
        operation: "switch",
        target: "GitHub",
        correction: true,
      }).valid,
    ).toBe(true);
    expect(
      validateSchema(tabsAction.schema, {
        action: "tabs",
        operation: "switch",
        target: "GitHub",
        correction: false,
      }).valid,
    ).toBe(false);
    expect(
      validateSchema(tabsAction.schema, {
        action: "tabs",
        operation: "new",
        correction: true,
      }).valid,
    ).toBe(false);
  });

  it("uses a generic switch confirmation for an untitled tab", async () => {
    chromeStub.tabs.query.mockResolvedValue([
      chromeTab({
        id: 42,
        windowId: 5,
        title: "",
        url: "https://example.test",
      }),
    ]);
    chromeStub.tabs.get.mockResolvedValue(
      chromeTab({ id: 42, windowId: 5, title: "" }),
    );

    await expect(
      tabsAction.execute(
        { action: "tabs", operation: "switch", target: "example" },
        {},
      ),
    ).resolves.toEqual({ spoken: "Switched to the tab." });
  });

  it("turns stale tab lookup failures into a stable error", async () => {
    chromeStub.tabs.query.mockResolvedValue([
      chromeTab({ id: 12, windowId: 5, title: "Closed target" }),
    ]);
    chromeStub.tabs.get.mockRejectedValue(new Error("No tab with id: 12"));

    await expect(
      tabsAction.execute(
        { action: "tabs", operation: "switch", target: "Closed target" },
        {},
      ),
    ).rejects.toThrow("Tab 12 is no longer open");
    expect(chromeStub.tabs.update).not.toHaveBeenCalled();
    expect(chromeStub.windows.update).not.toHaveBeenCalled();
  });

  it("fails clearly when no open tab matches the transcript-derived target", async () => {
    chromeStub.tabs.query.mockResolvedValue([
      chromeTab({ id: 12, windowId: 5, title: "Inbox" }),
    ]);

    await expect(
      tabsAction.execute(
        { action: "tabs", operation: "switch", target: "weather forecast" },
        {},
      ),
    ).rejects.toThrow('No open tab matches "weather forecast"');
    expect(chromeStub.tabs.get).not.toHaveBeenCalled();
  });

  it.each([
    ["mute", true, "Muted"],
    ["unmute", false, "Unmuted"],
  ] as const)(
    "%ss the active tab",
    async (operation, muted, spokenVerb) => {
      chromeStub.tabs.query.mockResolvedValue([
        chromeTab({ id: 20, windowId: 1, title: "Video" }),
      ]);

      await expect(
        tabsAction.execute({ action: "tabs", operation }, {}),
      ).resolves.toEqual({ spoken: `${spokenVerb} Video.` });

      expect(chromeStub.tabs.query).toHaveBeenCalledWith({
        active: true,
        currentWindow: true,
      });
      expect(chromeStub.tabs.update).toHaveBeenCalledWith(20, { muted });
    },
  );

  it("uses a generic mute confirmation for an untitled active tab", async () => {
    chromeStub.tabs.query.mockResolvedValue([
      chromeTab({ id: 21, windowId: 1 }),
    ]);

    await expect(
      tabsAction.execute({ action: "tabs", operation: "mute" }, {}),
    ).resolves.toEqual({ spoken: "Muted the tab." });

    expect(chromeStub.tabs.update).toHaveBeenCalledWith(21, { muted: true });
  });

  it("restores the first recently closed tab session", async () => {
    chromeStub.sessions.getRecentlyClosed.mockResolvedValue([
      { window: { sessionId: "window-session" } },
      { tab: { title: "Missing session" } },
      { tab: { sessionId: "tab-session" } },
      { tab: { sessionId: "older-tab-session" } },
    ]);

    await expect(
      tabsAction.execute({ action: "tabs", operation: "reopen" }, {}),
    ).resolves.toEqual({ spoken: "Reopened the last closed tab." });

    expect(chromeStub.sessions.getRecentlyClosed).toHaveBeenCalledWith({
      maxResults: 10,
    });
    expect(chromeStub.sessions.restore).toHaveBeenCalledWith("tab-session");
  });

  it("does not restore a window or a tab without a session id", async () => {
    chromeStub.sessions.getRecentlyClosed.mockResolvedValue([
      { window: { sessionId: "window-session" } },
      { tab: { title: "Missing session" } },
    ]);

    await expect(
      tabsAction.execute({ action: "tabs", operation: "reopen" }, {}),
    ).rejects.toThrow("There is no recently closed tab to reopen");
    expect(chromeStub.sessions.restore).not.toHaveBeenCalled();
  });
});
