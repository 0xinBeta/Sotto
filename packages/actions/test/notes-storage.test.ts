import { describe, expect, it, vi } from "vitest";

import {
  MAX_NOTE_BODY_LENGTH,
  MAX_NOTES,
  MAX_PENDING_REMINDERS,
  MAX_REMINDER_DELAY_MINUTES,
  NOTES_CAP_MESSAGE,
  NOTES_SCHEMA_VERSION,
  NotesReminderStore,
  parseReminderDelayMinutes,
  REMINDERS_CAP_MESSAGE,
  STORAGE_FULL_MESSAGE,
  type ReminderRecord,
} from "../src/notes/storage.js";
import { restrictNotesStorageAccess } from "../src/notes/storage-access.js";
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

  it("normalizes and bounds an optional note tag", async () => {
    const accepted = makeStore();
    await expect(
      accepted.store.createNote({
        body: "Benchmark the build",
        tag: "  project   apollo  ",
      }),
    ).resolves.toMatchObject({ tag: "project apollo" });

    const rejected = makeStore();
    await expect(
      rejected.store.createNote({
        body: "Do not save",
        tag: "x".repeat(41),
      }),
    ).rejects.toThrow("Note tag must contain at most 40 characters");
    expect(rejected.storage.set).not.toHaveBeenCalled();
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
    expect(storage.get).toHaveBeenCalledWith([
      "schemaVersion",
      "note:same-id",
    ]);
  });

  it("refuses a note before writing when the note cap is reached", async () => {
    const notes = Object.fromEntries(
      Array.from({ length: MAX_NOTES }, (_, index) => {
        const id = `note-${index}`;
        return [
          `note:${id}`,
          {
            id,
            body: `Note ${index}`,
            createdAt: NOW.toISOString(),
            updatedAt: NOW.toISOString(),
          },
        ];
      }),
    );
    const storage = new MemoryStorageArea({
      schemaVersion: NOTES_SCHEMA_VERSION,
      ...notes,
    });
    const { store } = makeStore(storage);

    await expect(store.createNote({ body: "One more note" })).rejects.toThrow(
      NOTES_CAP_MESSAGE,
    );
    expect(storage.set).not.toHaveBeenCalled();
  });

  it("surfaces a quota error and removes a partially written note", async () => {
    const storage = new MemoryStorageArea();
    storage.set.mockImplementationOnce(async (items) => {
      storage.values["note:record-1"] = items["note:record-1"];
      throw new Error("QUOTA_BYTES quota exceeded");
    });
    const { store } = makeStore(storage);

    await expect(store.createNote({ body: "Do not keep this" })).rejects.toThrow(
      STORAGE_FULL_MESSAGE,
    );
    expect(storage.values).toEqual({});
  });

  it("enforces the note size at the storage boundary", async () => {
    const accepted = makeStore();
    await expect(
      accepted.store.createNote({
        body: "x".repeat(MAX_NOTE_BODY_LENGTH),
      }),
    ).resolves.toMatchObject({
      body: "x".repeat(MAX_NOTE_BODY_LENGTH),
    });

    const rejected = makeStore();
    await expect(
      rejected.store.createNote({
        body: "x".repeat(MAX_NOTE_BODY_LENGTH + 1),
      }),
    ).rejects.toThrow(
      `Note body must contain at most ${MAX_NOTE_BODY_LENGTH} characters`,
    );
    expect(rejected.storage.set).not.toHaveBeenCalled();
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

  it("deletes the most recent note first", async () => {
    const older = {
      id: "older",
      body: "Older note",
      createdAt: "2026-07-28T10:00:00.000Z",
      updatedAt: "2026-07-28T10:00:00.000Z",
    };
    const newer = {
      id: "newer",
      body: "Newer note",
      createdAt: "2026-07-28T11:00:00.000Z",
      updatedAt: "2026-07-28T11:00:00.000Z",
    };
    const storage = new MemoryStorageArea({
      schemaVersion: NOTES_SCHEMA_VERSION,
      "note:older": older,
      "note:newer": newer,
    });
    const { store } = makeStore(storage);

    await expect(store.deleteLastNote()).resolves.toEqual(newer);
    await expect(store.listNotes()).resolves.toEqual([older]);
    expect(storage.remove).toHaveBeenCalledWith("note:newer");
  });

  it("deletes one note by its validated id", async () => {
    const note = {
      id: "target",
      body: "Delete this note",
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    };
    const storage = new MemoryStorageArea({
      schemaVersion: NOTES_SCHEMA_VERSION,
      "note:target": note,
    });
    const { store } = makeStore(storage);

    await expect(store.deleteNote("target")).resolves.toBe(true);
    await expect(store.deleteNote("missing")).resolves.toBe(false);
    await expect(store.deleteNote("../bad")).rejects.toThrow(
      "A valid note id is required",
    );
  });
});

describe("reminder scheduling", () => {
  it("lists only pending reminders with the soonest first", async () => {
    const later = reminder("later", "2026-07-28T12:30:00.000Z");
    const sooner = reminder("sooner", "2026-07-28T12:10:00.000Z");
    const delivered = reminder(
      "delivered",
      "2026-07-28T12:05:00.000Z",
      "delivered",
    );
    const storage = new MemoryStorageArea({
      schemaVersion: NOTES_SCHEMA_VERSION,
      "reminder:later": later,
      "reminder:sooner": sooner,
      "reminder:delivered": delivered,
    });
    const { store } = makeStore(storage);

    await expect(store.listPendingReminders()).resolves.toEqual([
      sooner,
      later,
    ]);
  });

  it("refuses a reminder before writing when the pending cap is reached", async () => {
    const reminders = Object.fromEntries(
      Array.from({ length: MAX_PENDING_REMINDERS }, (_, index) => {
        const record = reminder(
          `pending-${index}`,
          "2026-07-28T12:30:00.000Z",
        );
        return [`reminder:${record.id}`, record];
      }),
    );
    const delivered = reminder(
      "delivered-extra",
      "2026-07-28T12:05:00.000Z",
      "delivered",
    );
    const storage = new MemoryStorageArea({
      schemaVersion: NOTES_SCHEMA_VERSION,
      ...reminders,
      "reminder:delivered-extra": delivered,
    });
    const { store, alarms } = makeStore(storage);

    await expect(
      store.scheduleReminder({
        text: "One more reminder",
        delayMinutes: 1,
      }),
    ).rejects.toThrow(REMINDERS_CAP_MESSAGE);
    expect(storage.set).not.toHaveBeenCalled();
    expect(alarms.create).not.toHaveBeenCalled();
  });

  it("surfaces a reminder quota error before it creates an alarm", async () => {
    const storage = new MemoryStorageArea();
    storage.set.mockRejectedValueOnce(
      new Error("QUOTA_BYTES quota exceeded"),
    );
    const alarms = new MemoryAlarmStore();
    const { store } = makeStore(storage, alarms);

    await expect(
      store.scheduleReminder({
        text: "Do not schedule this",
        delayMinutes: 1,
      }),
    ).rejects.toThrow(STORAGE_FULL_MESSAGE);
    expect(storage.values).toEqual({});
    expect(alarms.create).not.toHaveBeenCalled();
  });

  it("removes storage before clearing an alarm and reconciles a stray", async () => {
    const record = reminder("cancel", "2026-07-28T12:10:00.000Z");
    const storage = new MemoryStorageArea({
      schemaVersion: NOTES_SCHEMA_VERSION,
      "reminder:cancel": record,
    });
    const alarms = new MemoryAlarmStore();
    alarms.alarms.set(record.alarmName, {
      name: record.alarmName,
      when: Date.parse(record.dueAt),
    });
    alarms.clear.mockRejectedValueOnce(new Error("alarm registry busy"));
    const { store } = makeStore(storage, alarms);

    await expect(store.cancelReminder(record.id)).resolves.toBe(true);
    expect(storage.values["reminder:cancel"]).toBeUndefined();
    expect(
      storage.remove.mock.invocationCallOrder[0],
    ).toBeLessThan(alarms.clear.mock.invocationCallOrder[0]!);
    expect(alarms.alarms.has(record.alarmName)).toBe(true);

    await expect(store.reconcileReminders({ now: NOW })).resolves.toEqual({
      delivered: [],
      recreatedAlarmNames: [],
    });
    expect(alarms.alarms.has(record.alarmName)).toBe(false);
    expect(alarms.clear).toHaveBeenCalledTimes(2);
  });

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

  it("removes a persisted reminder when its alarm cannot be created", async () => {
    const storage = new MemoryStorageArea();
    const alarms = new MemoryAlarmStore();
    alarms.create.mockRejectedValue(new Error("alarm unavailable"));
    const { store } = makeStore(storage, alarms);

    await expect(
      store.scheduleReminder({
        text: "Do not surprise me later",
        delayMinutes: 1,
      }),
    ).rejects.toThrow("alarm unavailable");
    expect(storage.values["reminder:record-1"]).toBeUndefined();
    expect(storage.remove).toHaveBeenCalledWith("reminder:record-1");
  });

  it("saves a snooze before its alarm and restores delivery on failure", async () => {
    const delivered = reminder(
      "snooze",
      "2026-07-28T11:59:00.000Z",
      "delivered",
    );
    const storage = new MemoryStorageArea({
      schemaVersion: NOTES_SCHEMA_VERSION,
      "reminder:snooze": delivered,
    });
    const alarms = new MemoryAlarmStore();
    const order: string[] = [];
    storage.set.mockImplementation(async (items) => {
      order.push(
        (items["reminder:snooze"] as ReminderRecord).status,
      );
      Object.assign(storage.values, items);
    });
    alarms.create.mockImplementation(async () => {
      order.push("alarm");
      throw new Error("alarm unavailable");
    });
    const { store } = makeStore(storage, alarms);

    await expect(store.snoozeReminder("snooze", 10)).rejects.toThrow(
      "alarm unavailable",
    );

    expect(order).toEqual(["scheduled", "alarm", "delivered"]);
    expect(storage.values["reminder:snooze"]).toEqual(delivered);
  });

  it("allows a new snooze after the rescheduled reminder fires", async () => {
    let now = new Date(NOW);
    const delivered = reminder(
      "repeat",
      "2026-07-28T11:59:00.000Z",
      "delivered",
    );
    const storage = new MemoryStorageArea({
      schemaVersion: NOTES_SCHEMA_VERSION,
      "reminder:repeat": delivered,
    });
    const alarms = new MemoryAlarmStore();
    const store = new NotesReminderStore({
      storage,
      alarms,
      now: () => new Date(now),
    });

    await expect(store.snoozeReminder("repeat", 5)).resolves.toMatchObject({
      dueAt: "2026-07-28T12:05:00.000Z",
      status: "scheduled",
    });

    now = new Date("2026-07-28T12:06:00.000Z");
    await expect(
      store.handleReminderAlarm("reminder:repeat", { now }),
    ).resolves.toMatchObject({ status: "delivered" });
    await expect(store.snoozeReminder("repeat", 30)).resolves.toMatchObject({
      dueAt: "2026-07-28T12:36:00.000Z",
      status: "scheduled",
    });
    expect(alarms.create).toHaveBeenLastCalledWith("reminder:repeat", {
      when: Date.parse("2026-07-28T12:36:00.000Z"),
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
    const alarms = new MemoryAlarmStore();
    const { store } = makeStore(storage, alarms);

    await expect(
      store.reconcileReminders({
        now: NOW,
        onDue: async () => {
          throw new Error("notification unavailable");
        },
      }),
    ).rejects.toThrow("notification unavailable");
    expect(storage.values["reminder:retry"]).toEqual(due);
    expect(alarms.create).toHaveBeenCalledWith("reminder:retry", {
      when: NOW.getTime() + 30_000,
    });
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

  it("reschedules a consumed alarm when reminder delivery fails", async () => {
    const due = reminder("retry-alarm", "2026-07-28T11:59:00.000Z");
    const storage = new MemoryStorageArea({
      schemaVersion: NOTES_SCHEMA_VERSION,
      "reminder:retry-alarm": due,
    });
    const alarms = new MemoryAlarmStore();
    const { store } = makeStore(storage, alarms);

    await expect(
      store.handleReminderAlarm("reminder:retry-alarm", {
        now: NOW,
        onDue: async () => {
          throw new Error("all delivery sinks unavailable");
        },
      }),
    ).rejects.toThrow("all delivery sinks unavailable");
    expect(storage.values["reminder:retry-alarm"]).toEqual(due);
    expect(alarms.create).toHaveBeenCalledWith(
      "reminder:retry-alarm",
      { when: NOW.getTime() + 30_000 },
    );
  });
});
