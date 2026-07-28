import { afterEach, describe, expect, it, vi } from "vitest";

const worker = vi.hoisted(() => ({
  speak: vi.fn(),
}));

vi.mock("@sotto/actions", () => ({ default: [] }));
vi.mock("@sotto/core", () => ({
  ActionRegistry: class ActionRegistry {},
  CommandRouter: class CommandRouter {},
  CommandValidationError: class CommandValidationError extends Error {},
  DestinationRegistry: class DestinationRegistry {},
}));
vi.mock("@sotto/destinations", () => ({
  default: [],
  executeDestinationFollowUp: vi.fn(),
}));
vi.mock("@sotto/tts", () => ({
  SystemTtsEngine: class SystemTtsEngine {
    speak = worker.speak;
    speakLong = worker.speak;
    stop = vi.fn();
  },
}));

interface ReminderHarness {
  readonly values: Record<string, unknown>;
  readonly alarmCreate: ReturnType<typeof vi.fn>;
  readonly alarmListener: (alarm: { readonly name: string }) => void;
  readonly notificationClickListener: (notificationId: string) => void;
  readonly notificationCreate: ReturnType<typeof vi.fn>;
  readonly notificationClear: ReturnType<typeof vi.fn>;
  readonly panelSend: ReturnType<typeof vi.fn>;
  readonly storageSet: ReturnType<typeof vi.fn>;
  readonly tabUpdate: ReturnType<typeof vi.fn>;
  readonly windowUpdate: ReturnType<typeof vi.fn>;
}

function reminder(
  id: string,
  dueAt: string,
  status: "scheduled" | "delivered" = "scheduled",
  locations: {
    readonly sourceTabId?: number;
    readonly sourceWindowId?: number;
  } = {},
) {
  return {
    id,
    text: `Reminder ${id}`,
    dueAt,
    status,
    alarmName: `reminder:${id}`,
    ...locations,
  };
}

async function installBackground(options: {
  readonly values?: Record<string, unknown>;
  readonly existingAlarms?: readonly string[];
  readonly notificationPermission?: "granted" | "denied";
  readonly panelAvailable?: boolean;
  readonly windowUpdateRejects?: boolean;
} = {}): Promise<ReminderHarness> {
  const values = { ...(options.values ?? {}) };
  const alarms = new Map(
    (options.existingAlarms ?? []).map((name) => [name, { name }]),
  );
  let alarmListener:
    | ((alarm: { readonly name: string }) => void)
    | undefined;
  let notificationClickListener:
    | ((notificationId: string) => void)
    | undefined;
  const panelSend = vi.fn();
  const runtimeSend = vi.fn(
    async (message: { readonly target?: string }) => {
      if (message.target === "sidepanel") {
        panelSend(message);
        if (options.panelAvailable === false) {
          throw new Error("Receiving end does not exist");
        }
        return undefined;
      }
      if (message.target === "offscreen") return { ok: true };
      return undefined;
    },
  );
  const storageGet = vi.fn(
    async (keys?: string | readonly string[] | null) => {
      if (keys === undefined || keys === null) return { ...values };
      const selected = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(
        selected
          .filter((key) =>
            Object.prototype.hasOwnProperty.call(values, key),
          )
          .map((key) => [key, values[key]]),
      );
    },
  );
  const storageSet = vi.fn(async (items: Record<string, unknown>) => {
    Object.assign(values, items);
  });
  const alarmCreate = vi.fn(
    async (name: string, info: { readonly when: number }) => {
      alarms.set(name, { name, ...info });
    },
  );
  const notificationCreate = vi.fn().mockResolvedValue(undefined);
  const notificationClear = vi.fn().mockResolvedValue(true);
  const windowUpdate = options.windowUpdateRejects
    ? vi.fn().mockRejectedValue(new Error("window was closed"))
    : vi.fn().mockResolvedValue(undefined);
  const tabUpdate = vi.fn().mockResolvedValue(undefined);

  vi.stubGlobal("chrome", {
    runtime: {
      getURL: vi.fn((path: string) => `chrome-extension://sotto/${path}`),
      getContexts: vi
        .fn()
        .mockResolvedValue([{ contextType: "OFFSCREEN_DOCUMENT" }]),
      sendMessage: runtimeSend,
      onMessage: { addListener: vi.fn() },
      onInstalled: { addListener: vi.fn() },
      onStartup: { addListener: vi.fn() },
    },
    offscreen: { createDocument: vi.fn() },
    sidePanel: {
      open: vi.fn().mockResolvedValue(undefined),
      setPanelBehavior: vi.fn().mockResolvedValue(undefined),
    },
    storage: {
      local: {
        get: storageGet,
        set: storageSet,
        setAccessLevel: vi.fn().mockResolvedValue(undefined),
      },
    },
    alarms: {
      get: vi.fn(async (name: string) => alarms.get(name)),
      create: alarmCreate,
      clear: vi.fn(async (name: string) => alarms.delete(name)),
      onAlarm: {
        addListener: vi.fn((listener) => {
          alarmListener = listener;
        }),
      },
    },
    notifications: {
      getPermissionLevel: vi
        .fn()
        .mockResolvedValue(options.notificationPermission ?? "granted"),
      create: notificationCreate,
      clear: notificationClear,
      onClicked: {
        addListener: vi.fn((listener) => {
          notificationClickListener = listener;
        }),
      },
    },
    tabs: {
      query: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      update: tabUpdate,
      sendMessage: vi.fn(),
    },
    windows: {
      WINDOW_ID_CURRENT: -2,
      update: windowUpdate,
    },
    scripting: { executeScript: vi.fn() },
    commands: { onCommand: { addListener: vi.fn() } },
  });

  await import("../src/background.js");
  await vi.waitFor(() => expect(storageGet).toHaveBeenCalled());
  if (!alarmListener || !notificationClickListener) {
    throw new Error("Background reminder listeners were not installed");
  }
  return {
    values,
    alarmCreate,
    alarmListener,
    notificationClickListener,
    notificationCreate,
    notificationClear,
    panelSend,
    storageSet,
    tabUpdate,
    windowUpdate,
  };
}

afterEach(() => {
  worker.speak.mockReset();
  vi.resetModules();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("background reminder recovery", () => {
  it("recreates a future reminder alarm during worker startup", async () => {
    const future = reminder("future", "2099-01-01T00:00:00.000Z");
    const harness = await installBackground({
      values: {
        schemaVersion: 1,
        "reminder:future": future,
      },
    });

    await vi.waitFor(() =>
      expect(harness.alarmCreate).toHaveBeenCalledWith("reminder:future", {
        when: Date.parse(future.dueAt),
      }),
    );
    expect(harness.values["reminder:future"]).toEqual(future);
  });

  it("ignores an alarm whose storage record is missing", async () => {
    const harness = await installBackground({
      values: { schemaVersion: 1 },
    });
    harness.storageSet.mockClear();
    harness.alarmCreate.mockClear();

    harness.alarmListener({ name: "reminder:missing" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(harness.notificationCreate).not.toHaveBeenCalled();
    expect(harness.storageSet).not.toHaveBeenCalled();
    expect(harness.alarmCreate).not.toHaveBeenCalled();
    expect(worker.speak).not.toHaveBeenCalled();
  });

  it("uses panel and speech fallbacks when notifications are denied", async () => {
    const future = reminder("denied", "2099-01-01T00:00:00.000Z");
    const harness = await installBackground({
      values: {
        schemaVersion: 1,
        "reminder:denied": future,
      },
      existingAlarms: ["reminder:denied"],
      notificationPermission: "denied",
    });
    harness.values["reminder:denied"] = reminder(
      "denied",
      "2000-01-01T00:00:00.000Z",
    );
    harness.storageSet.mockClear();
    worker.speak.mockResolvedValue(undefined);

    harness.alarmListener({ name: "reminder:denied" });
    await vi.waitFor(() =>
      expect(harness.values["reminder:denied"]).toMatchObject({
        status: "delivered",
      }),
    );

    expect(harness.notificationCreate).not.toHaveBeenCalled();
    expect(harness.panelSend).toHaveBeenCalledWith(
      expect.objectContaining({
        target: "sidepanel",
        type: "reminder-fired",
        reminder: expect.objectContaining({
          id: "denied",
          notificationPermission: "denied",
        }),
      }),
    );
    expect(worker.speak).toHaveBeenCalledWith("Reminder: Reminder denied", {
      lang: "en-US",
    });
  });

  it("keeps a denied reminder scheduled when every fallback fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const future = reminder("retry", "2099-01-01T00:00:00.000Z");
    const harness = await installBackground({
      values: {
        schemaVersion: 1,
        "reminder:retry": future,
      },
      existingAlarms: ["reminder:retry"],
      notificationPermission: "denied",
      panelAvailable: false,
    });
    const due = reminder("retry", "2000-01-01T00:00:00.000Z");
    harness.values["reminder:retry"] = due;
    harness.storageSet.mockClear();
    worker.speak.mockRejectedValue(new Error("no local voice"));

    harness.alarmListener({ name: "reminder:retry" });
    await vi.waitFor(() =>
      expect(console.warn).toHaveBeenCalledWith(
        "Sotto could not deliver a reminder",
        expect.any(Error),
      ),
    );

    expect(harness.values["reminder:retry"]).toEqual(due);
    expect(harness.storageSet).not.toHaveBeenCalled();
    expect(harness.notificationCreate).not.toHaveBeenCalled();
  });

  it("clears and publishes a clicked reminder even if its source window is gone", async () => {
    const record = reminder(
      "clicked",
      "2026-07-28T12:00:00.000Z",
      "delivered",
      { sourceTabId: 8, sourceWindowId: 4 },
    );
    const harness = await installBackground({
      values: {
        schemaVersion: 1,
        "reminder:clicked": record,
      },
      windowUpdateRejects: true,
    });

    harness.notificationClickListener("reminder:clicked");
    await vi.waitFor(() =>
      expect(harness.notificationClear).toHaveBeenCalledWith(
        "reminder:clicked",
      ),
    );

    expect(harness.windowUpdate).toHaveBeenCalledWith(4, { focused: true });
    expect(harness.tabUpdate).toHaveBeenCalledWith(8, { active: true });
    expect(harness.panelSend).toHaveBeenCalledWith(
      expect.objectContaining({
        target: "sidepanel",
        type: "reminder-opened",
        reminder: expect.objectContaining({ id: "clicked" }),
      }),
    );
  });
});
