import { describe, expect, it, vi } from "vitest";

import {
  MAX_REMINDER_DELAY_MINUTES,
  NOTES_SCHEMA_VERSION,
  NotesReminderStore,
  parseReminderDelayMinutes,
  restrictNotesStorageAccess,
  type ReminderRecord,
} from "../src/notes/storage.js";
import {
  MemoryAlarmStore,
  MemoryStorageArea,
} from "./notes-chrome-stub.js";

const NOW = new Date("2026-07-28T12:00:00.000Z");

function makeStore(
  storage = new MemoryStorageArea(),
  alarms = new MemoryAlarmStore(),
  ids: string[] = ["record-1"],
) {
  let index = 0;
  return {
    storage,
    alarms,
    store: new NotesReminderStore({
      storage,
      alarms,
      now: () => new Date(NOW),
      createId: () => ids[index++] ?? `record-${index}`,
    }),
  };
}

function reminder(
  id: string,
  dueAt: string,
  status: ReminderRecord["status"] = "scheduled",
): ReminderRecord {
  return {
    id,
    text: `Reminder ${id}`,
    dueAt,
    status,
    alarmName: `reminder:${id}`,
  };
}

describe("notes storage", () => {
  it("writes and lists versioned per-record note keys", async () => {
    const { store, storage } = makeStore();

    await expect(store.createNote({ body: "  Buy oat milk  " })).resolves.toEqual(
      {
        id: "record-1",
        body: "Buy oat milk",
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      },
    );

    expect(storage.values.schemaVersion).toBe(NOTES_SCHEMA_VERSION);
    expect(storage.values["note:record-1"]).toEqual({
      id: "record-1",
      body: "Buy oat milk",
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
    await expect(store.listNotes()).resolves.toHaveLength(1);
  });

  it("serializes concurrent mutations and rereads before allocating ids", async () => {
    const { store, storage } = makeStore(
      undefined,
      undefined,
      ["same-id", "same-id", "second-id"],
    );

    const [first, second] = await Promise.all([
      store.createNote({ body: "First" }),
      store.createNote({ body: "Second" }),
    ]);

    expect(first.id).toBe("same-id");
    expect(second.id).toBe("second-id");
    expect(storage.values["note:same-id"]).toBeDefined();
    expect(storage.values["note:second-id"]).toBeDefined();
    expect(storage.get).toHaveBeenCalledTimes(3);
  });

  it("rejects invalid persisted JSON instead of treating it as a note", async () => {
    const storage = new MemoryStorageArea({
      schemaVersion: NOTES_SCHEMA_VERSION,
      "note:broken": {
        id: "different-id",
        body: "Broken",
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      },
    });
    const { store } = makeStore(storage);

    await expect(store.listNotes()).rejects.toThrow(
      "Invalid note record at note:broken",
    );
  });

  it("restricts storage.local to trusted extension contexts", async () => {
    const storage = new MemoryStorageArea();

    await restrictNotesStorageAccess(storage);

    expect(storage.setAccessLevel).toHaveBeenCalledWith({
      accessLevel: "TRUSTED_CONTEXTS",
    });
  });
});

describe("reminder scheduling", () => {
  it.each([0.5, 1, MAX_REMINDER_DELAY_MINUTES])(
    "accepts the bounded delay %s minutes",
    (delay) => {
      expect(parseReminderDelayMinutes(delay)).toBe(delay);
    },
  );

  it.each([
    0,
    0.499,
    MAX_REMINDER_DELAY_MINUTES + 1,
    Number.NaN,
    "5",
  ])("rejects an invalid delay %s", (delay) => {
    expect(() => parseReminderDelayMinutes(delay)).toThrow();
  });

  it("persists the reminder before creating its stable alarm", async () => {
    const storage = new MemoryStorageArea();
    const alarms = new MemoryAlarmStore();
    const order: string[] = [];
    storage.set.mockImplementation(async (items) => {
      order.push("storage");
      Object.assign(storage.values, items);
    });
    alarms.create.mockImplementation(async (name, info) => {
      order.push("alarm");
      alarms.alarms.set(name, { name, when: info.when });
    });
    const { store } = makeStore(storage, alarms);

    const created = await store.scheduleReminder({
      text: " Stand up ",
      delayMinutes: 0.5,
      sourceTabId: 4,
      sourceWindowId: 2,
    });

    expect(created).toEqual({
      id: "record-1",
      text: "Stand up",
      dueAt: "2026-07-28T12:00:30.000Z",
      status: "scheduled",
      alarmName: "reminder:record-1",
      sourceTabId: 4,
      sourceWindowId: 2,
    });
    expect(order).toEqual(["storage", "alarm"]);
    expect(alarms.create).toHaveBeenCalledWith("reminder:record-1", {
      when: NOW.getTime() + 30_000,
    });
  });

  it("retries duplicate reminder ids without overwriting the first record", async () => {
    const { store, storage } = makeStore(
      undefined,
      undefined,
      ["same-id", "same-id", "second-id"],
    );

    const first = await store.scheduleReminder({
      text: "First reminder",
      delayMinutes: 1,
    });
    const second = await store.scheduleReminder({
      text: "Second reminder",
      delayMinutes: 2,
    });

    expect(first.id).toBe("same-id");
    expect(second.id).toBe("second-id");
    expect(storage.values["reminder:same-id"]).toMatchObject({
      text: "First reminder",
    });
    expect(storage.values["reminder:second-id"]).toMatchObject({
      text: "Second reminder",
    });
  });
});

describe("alarm reconciliation", () => {
  it("marks overdue reminders once and recreates missing future alarms", async () => {
    const overdue = reminder(
      "overdue",
      "2026-07-28T11:59:00.000Z",
    );
    const missing = reminder(
      "missing",
      "2026-07-28T12:10:00.000Z",
    );
    const present = reminder(
      "present",
      "2026-07-28T12:20:00.000Z",
    );
    const storage = new MemoryStorageArea({
      schemaVersion: NOTES_SCHEMA_VERSION,
      "reminder:overdue": overdue,
      "reminder:missing": missing,
      "reminder:present": present,
    });
    const alarms = new MemoryAlarmStore();
    alarms.alarms.set("reminder:overdue", {
      name: "reminder:overdue",
      when: Date.parse(overdue.dueAt),
    });
    alarms.alarms.set("reminder:present", {
      name: "reminder:present",
      when: Date.parse(present.dueAt),
    });
    const { store } = makeStore(storage, alarms);
    const onDue = vi.fn(async () => undefined);

    await expect(
      store.reconcileReminders({ now: NOW, onDue }),
    ).resolves.toEqual({
      delivered: [{ ...overdue, status: "delivered" }],
      recreatedAlarmNames: ["reminder:missing"],
    });
    expect(onDue).toHaveBeenCalledOnce();
    expect(alarms.clear).toHaveBeenCalledWith("reminder:overdue");
    expect(alarms.create).toHaveBeenCalledWith("reminder:missing", {
      when: Date.parse(missing.dueAt),
    });
    expect(storage.values["reminder:overdue"]).toEqual({
      ...overdue,
      status: "delivered",
    });

    await expect(
      store.reconcileReminders({ now: NOW, onDue }),
    ).resolves.toEqual({
      delivered: [],
      recreatedAlarmNames: [],
    });
    expect(onDue).toHaveBeenCalledOnce();
  });

  it("does not mark a reminder delivered when its notification callback fails", async () => {
    const due = reminder("retry", "2026-07-28T11:59:00.000Z");
    const storage = new MemoryStorageArea({
      schemaVersion: NOTES_SCHEMA_VERSION,
      "reminder:retry": due,
    });
    const { store } = makeStore(storage);

    await expect(
      store.reconcileReminders({
        now: NOW,
        onDue: async () => {
          throw new Error("notification unavailable");
        },
      }),
    ).rejects.toThrow("notification unavailable");
    expect(storage.values["reminder:retry"]).toEqual(due);
  });

  it("commits each overdue delivery before attempting the next one", async () => {
    const first = reminder("first", "2026-07-28T11:58:00.000Z");
    const second = reminder("second", "2026-07-28T11:59:00.000Z");
    const storage = new MemoryStorageArea({
      schemaVersion: NOTES_SCHEMA_VERSION,
      "reminder:first": first,
      "reminder:second": second,
    });
    const alarms = new MemoryAlarmStore();
    const { store } = makeStore(storage, alarms);
    const delivered: string[] = [];

    await expect(
      store.reconcileReminders({
        now: NOW,
        onDue: async (record) => {
          delivered.push(record.id);
          if (record.id === "second") throw new Error("second failed");
        },
      }),
    ).rejects.toThrow("second failed");

    expect(delivered).toEqual(["first", "second"]);
    expect(storage.values["reminder:first"]).toEqual({
      ...first,
      status: "delivered",
    });
    expect(storage.values["reminder:second"]).toEqual(second);
    expect(alarms.clear).toHaveBeenCalledWith("reminder:first");
  });

  it("handles a stable alarm idempotently and reschedules an early alarm", async () => {
    const due = reminder("alarm", "2026-07-28T12:01:00.000Z");
    const storage = new MemoryStorageArea({
      schemaVersion: NOTES_SCHEMA_VERSION,
      "reminder:alarm": due,
    });
    const alarms = new MemoryAlarmStore();
    const { store } = makeStore(storage, alarms);
    const onDue = vi.fn();

    await expect(
      store.handleReminderAlarm("reminder:alarm", {
        now: NOW,
        onDue,
      }),
    ).resolves.toBeUndefined();
    expect(alarms.create).toHaveBeenCalledWith("reminder:alarm", {
      when: Date.parse(due.dueAt),
    });

    const afterDue = new Date("2026-07-28T12:02:00.000Z");
    await expect(
      store.handleReminderAlarm("reminder:alarm", {
        now: afterDue,
        onDue,
      }),
    ).resolves.toEqual({ ...due, status: "delivered" });
    await expect(
      store.handleReminderAlarm("reminder:alarm", {
        now: afterDue,
        onDue,
      }),
    ).resolves.toBeUndefined();
    expect(onDue).toHaveBeenCalledOnce();
  });

  it("ignores a reminder alarm whose storage record is missing", async () => {
    const storage = new MemoryStorageArea({
      schemaVersion: NOTES_SCHEMA_VERSION,
    });
    const alarms = new MemoryAlarmStore();
    const { store } = makeStore(storage, alarms);
    const onDue = vi.fn();

    await expect(
      store.handleReminderAlarm("reminder:missing", {
        now: NOW,
        onDue,
      }),
    ).resolves.toBeUndefined();
    expect(onDue).not.toHaveBeenCalled();
    expect(storage.set).not.toHaveBeenCalled();
    expect(alarms.create).not.toHaveBeenCalled();
  });
});
