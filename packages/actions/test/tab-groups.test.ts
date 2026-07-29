import { validateSchema } from "@sotto/core";
import { beforeEach, describe, expect, it } from "vitest";

import tabGroupsAction, {
  MAX_TAB_GROUP_TITLE_LENGTH,
} from "../src/tab-groups/index.js";
import { chromeTab, installChromeStub } from "./chrome-stub.js";

describe("tab groups action", () => {
  let chromeStub: ReturnType<typeof installChromeStub>;

  beforeEach(() => {
    chromeStub = installChromeStub();
  });

  it("declares the tab group permission", () => {
    expect(tabGroupsAction.permissions).toEqual(["tabs", "tabGroups"]);
  });

  it("accepts group titles from 1 through 40 characters", () => {
    const command = (title: string) => ({
      action: "tab-groups",
      operation: "group",
      title,
    });

    expect(validateSchema(tabGroupsAction.schema, command("r")).valid).toBe(
      true,
    );
    expect(
      validateSchema(
        tabGroupsAction.schema,
        command("r".repeat(MAX_TAB_GROUP_TITLE_LENGTH)),
      ).valid,
    ).toBe(true);
    expect(validateSchema(tabGroupsAction.schema, command("")).valid).toBe(
      false,
    );
    expect(validateSchema(tabGroupsAction.schema, command("   ")).valid).toBe(
      false,
    );
    expect(
      validateSchema(
        tabGroupsAction.schema,
        command("r".repeat(MAX_TAB_GROUP_TITLE_LENGTH + 1)),
      ).valid,
    ).toBe(false);
  });

  it("groups the highlighted tabs and names the new group", async () => {
    chromeStub.tabs.query.mockResolvedValue([
      chromeTab({ id: 4, windowId: 2, highlighted: true }),
      chromeTab({ id: 7, windowId: 2, highlighted: true }),
    ]);
    chromeStub.tabs.group.mockResolvedValue(18);

    await expect(
      tabGroupsAction.execute(
        {
          action: "tab-groups",
          operation: "group",
          title: "research",
        },
        {},
      ),
    ).resolves.toEqual({ spoken: "Grouped as research." });

    expect(chromeStub.tabs.query).toHaveBeenCalledWith({
      highlighted: true,
      currentWindow: true,
    });
    expect(chromeStub.tabs.group).toHaveBeenCalledWith({ tabIds: [4, 7] });
    expect(chromeStub.tabGroups.update).toHaveBeenCalledWith(18, {
      title: "research",
    });
  });

  it("uses the active tab when no highlighted tab is available", async () => {
    chromeStub.tabs.query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([chromeTab({ id: 9, windowId: 2 })]);
    chromeStub.tabs.group.mockResolvedValue(21);

    await tabGroupsAction.execute(
      {
        action: "tab-groups",
        operation: "group",
        title: "work",
      },
      {},
    );

    expect(chromeStub.tabs.query).toHaveBeenNthCalledWith(1, {
      highlighted: true,
      currentWindow: true,
    });
    expect(chromeStub.tabs.query).toHaveBeenNthCalledWith(2, {
      active: true,
      currentWindow: true,
    });
    expect(chromeStub.tabs.group).toHaveBeenCalledWith({ tabIds: [9] });
  });

  it("bounds a direct group title before it reaches Chrome", async () => {
    chromeStub.tabs.query.mockResolvedValue([
      chromeTab({ id: 4, windowId: 2 }),
    ]);
    chromeStub.tabs.group.mockResolvedValue(18);

    await tabGroupsAction.execute(
      {
        action: "tab-groups",
        operation: "group",
        title: `  ${"r".repeat(MAX_TAB_GROUP_TITLE_LENGTH + 5)}`,
      },
      {},
    );

    expect(chromeStub.tabGroups.update).toHaveBeenCalledWith(18, {
      title: "r".repeat(MAX_TAB_GROUP_TITLE_LENGTH),
    });
  });

  it("rejects an empty direct group title before it changes tabs", async () => {
    await expect(
      tabGroupsAction.execute(
        {
          action: "tab-groups",
          operation: "group",
          title: "   ",
        },
        {},
      ),
    ).rejects.toThrow("A tab group title is required");

    expect(chromeStub.tabs.query).not.toHaveBeenCalled();
    expect(chromeStub.tabs.group).not.toHaveBeenCalled();
    expect(chromeStub.tabGroups.update).not.toHaveBeenCalled();
  });

  it("ungroups the current tab", async () => {
    chromeStub.tabs.query.mockResolvedValue([
      chromeTab({ id: 11, windowId: 3 }),
    ]);

    await expect(
      tabGroupsAction.execute(
        {
          action: "tab-groups",
          operation: "ungroup",
          scope: "current",
        },
        {},
      ),
    ).resolves.toEqual({ spoken: "Ungrouped the tab." });

    expect(chromeStub.tabs.ungroup).toHaveBeenCalledWith([11]);
  });

  it("ungroups the highlighted tabs", async () => {
    chromeStub.tabs.query.mockResolvedValue([
      chromeTab({ id: 11, windowId: 3, highlighted: true }),
      chromeTab({ id: 13, windowId: 3, highlighted: true }),
    ]);

    await expect(
      tabGroupsAction.execute(
        {
          action: "tab-groups",
          operation: "ungroup",
          scope: "highlighted",
        },
        {},
      ),
    ).resolves.toEqual({ spoken: "Ungrouped the tabs." });

    expect(chromeStub.tabs.query).toHaveBeenCalledWith({
      highlighted: true,
      currentWindow: true,
    });
    expect(chromeStub.tabs.ungroup).toHaveBeenCalledWith([11, 13]);
  });

  it.each([
    ["collapse", true, "Collapsed your groups."],
    ["expand", false, "Expanded your groups."],
  ] as const)(
    "%ss all groups in the active window",
    async (operation, collapsed, spoken) => {
      chromeStub.tabs.query.mockResolvedValue([
        chromeTab({ id: 5, windowId: 8 }),
      ]);
      chromeStub.tabGroups.query.mockResolvedValue([
        { id: 31, windowId: 8 },
        { id: 32, windowId: 8 },
      ]);

      await expect(
        tabGroupsAction.execute(
          { action: "tab-groups", operation },
          {},
        ),
      ).resolves.toEqual({ spoken });

      expect(chromeStub.tabGroups.query).toHaveBeenCalledWith({
        windowId: 8,
      });
      expect(chromeStub.tabGroups.update).toHaveBeenCalledTimes(2);
      expect(chromeStub.tabGroups.update).toHaveBeenNthCalledWith(1, 31, {
        collapsed,
      });
      expect(chromeStub.tabGroups.update).toHaveBeenNthCalledWith(2, 32, {
        collapsed,
      });
    },
  );

  it("reports when the active window has no groups", async () => {
    chromeStub.tabs.query.mockResolvedValue([
      chromeTab({ id: 5, windowId: 8 }),
    ]);
    chromeStub.tabGroups.query.mockResolvedValue([]);

    await expect(
      tabGroupsAction.execute(
        { action: "tab-groups", operation: "collapse" },
        {},
      ),
    ).resolves.toEqual({ spoken: "You have no tab groups." });
    expect(chromeStub.tabGroups.update).not.toHaveBeenCalled();
  });
});
