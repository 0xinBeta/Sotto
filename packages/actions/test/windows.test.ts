import {
  ActionRegistry,
  CommandRouter,
  CommandValidationError,
  validateSchema,
} from "@sotto/core";
import { beforeEach, describe, expect, it } from "vitest";

import windowsAction from "../src/windows/index.js";
import { chromeTab, installChromeStub } from "./chrome-stub.js";

describe("windows action", () => {
  let chromeStub: ReturnType<typeof installChromeStub>;

  beforeEach(() => {
    chromeStub = installChromeStub();
  });

  it("opens a new window", async () => {
    await expect(
      windowsAction.execute(
        { action: "windows", operation: "new" },
        {},
      ),
    ).resolves.toEqual({ spoken: "Opened a new window." });

    expect(chromeStub.windows.create).toHaveBeenCalledWith();
  });

  it("closes the current window", async () => {
    chromeStub.windows.getCurrent.mockResolvedValue({ id: 6 });

    await expect(
      windowsAction.execute(
        { action: "windows", operation: "close" },
        {},
      ),
    ).resolves.toEqual({ spoken: "Closed the window." });

    expect(chromeStub.windows.getCurrent).toHaveBeenCalledWith();
    expect(chromeStub.windows.remove).toHaveBeenCalledWith(6);
  });

  it("moves the active tab to a new window", async () => {
    chromeStub.tabs.query.mockResolvedValue([
      chromeTab({ id: 19, windowId: 4 }),
    ]);

    await expect(
      windowsAction.execute(
        { action: "windows", operation: "move-tab" },
        {},
      ),
    ).resolves.toEqual({ spoken: "Moved the tab to a new window." });

    expect(chromeStub.tabs.query).toHaveBeenCalledWith({
      active: true,
      currentWindow: true,
    });
    expect(chromeStub.windows.create).toHaveBeenCalledWith({ tabId: 19 });
  });

  it("does not create a window when no active tab is available", async () => {
    chromeStub.tabs.query.mockResolvedValue([]);

    await expect(
      windowsAction.execute(
        { action: "windows", operation: "move-tab" },
        {},
      ),
    ).rejects.toThrow("No active tab is available");

    expect(chromeStub.windows.create).not.toHaveBeenCalled();
  });

  it.each([
    ["normal", "fullscreen", "Fullscreen is on."],
    ["fullscreen", "normal", "Fullscreen is off."],
  ] as const)(
    "changes the %s window state to %s",
    async (currentState, nextState, spoken) => {
      chromeStub.windows.getCurrent.mockResolvedValue({
        id: 8,
        state: currentState,
      });

      await expect(
        windowsAction.execute(
          { action: "windows", operation: "toggle-fullscreen" },
          {},
        ),
      ).resolves.toEqual({ spoken });

      expect(chromeStub.windows.getCurrent).toHaveBeenCalledWith();
      expect(chromeStub.windows.update).toHaveBeenCalledWith(8, {
        state: nextState,
      });
    },
  );

  it("fails when the current window has no id", async () => {
    chromeStub.windows.getCurrent.mockResolvedValue({ state: "normal" });

    await expect(
      windowsAction.execute(
        { action: "windows", operation: "toggle-fullscreen" },
        {},
      ),
    ).rejects.toThrow("No current window is available");

    expect(chromeStub.windows.update).not.toHaveBeenCalled();
  });

  it("uses the confirm tier only for window close", async () => {
    const router = new CommandRouter(new ActionRegistry([windowsAction]));
    const close = { action: "windows", operation: "close" } as const;

    expect(router.requiresConfirmation(close)).toBe(true);
    expect(
      router.requiresConfirmation({ action: "windows", operation: "new" }),
    ).toBe(false);
    expect(
      router.requiresConfirmation({
        action: "windows",
        operation: "move-tab",
      }),
    ).toBe(false);
    expect(
      router.requiresConfirmation({
        action: "windows",
        operation: "toggle-fullscreen",
      }),
    ).toBe(false);
    await expect(router.route(close)).rejects.toThrow(
      CommandValidationError,
    );
  });

  it("uses only an existing permission and rejects extra command data", () => {
    expect(windowsAction.permissions).toEqual(["tabs"]);
    expect(
      validateSchema(windowsAction.schema, {
        action: "windows",
        operation: "new",
      }).valid,
    ).toBe(true);
    expect(
      validateSchema(windowsAction.schema, {
        action: "windows",
        operation: "new",
        url: "https://page-derived.test",
      }).valid,
    ).toBe(false);
  });
});
