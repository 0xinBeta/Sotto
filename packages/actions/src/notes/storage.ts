import {
  MAX_NOTE_TAG_LENGTH,
  normalizeNoteTag,
} from "./tags.js";

export const NOTES_SCHEMA_VERSION = 1;
export const NOTES_SCHEMA_VERSION_KEY = "schemaVersion";
export const NOTE_KEY_PREFIX = "note:";
export const REMINDER_KEY_PREFIX = "reminder:";

export const MIN_REMINDER_DELAY_MINUTES = 0.5;
export const MAX_REMINDER_DELAY_MINUTES = 525_600;
export const MAX_NOTES = 500;
export const MAX_PENDING_REMINDERS = 100;
export const MAX_NOTE_BODY_LENGTH = 5_000;
export const MAX_REMINDER_TEXT_LENGTH = 1_000;
export const NOTES_CAP_MESSAGE =
  "You have 500 notes. Delete some first.";
export const REMINDERS_CAP_MESSAGE =
  "You have 100 pending reminders. Cancel some first.";
export const STORAGE_FULL_MESSAGE =
  "Storage is full. Delete some notes.";
const REMINDER_DELIVERY_RETRY_MS = 30_000;

export class NotesStorageUserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotesStorageUserError";
  }
}

export interface NoteSource {
  readonly title: string;
  readonly url: string;
}

export interface NoteRecord {
  readonly id: string;
  readonly body: string;
  readonly tag?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly source?: NoteSource;
}

export type ReminderStatus = "scheduled" | "delivered" | "dismissed";

export interface ReminderRecord {
  readonly id: string;
  readonly noteId?: string;
  readonly text: string;
  readonly dueAt: string;
  readonly status: ReminderStatus;
  readonly alarmName: string;
  readonly sourceTabId?: number;
  readonly sourceWindowId?: number;
}

export interface CreateNoteInput {
  readonly body: string;
  readonly tag?: string;
  readonly source?: NoteSource;
}

export interface ScheduleReminderInput {
  readonly text: string;
  readonly delayMinutes: number;
  readonly noteId?: string;
  readonly sourceTabId?: number;
  readonly sourceWindowId?: number;
}

export interface StorageAreaLike {
  get(
    keys?: string | readonly string[] | null,
  ): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | readonly string[]): Promise<void>;
  setAccessLevel?(options: {
    readonly accessLevel: "TRUSTED_CONTEXTS";
  }): Promise<void>;
}

export interface AlarmStoreLike {
  get(name: string): Promise<{ readonly name: string } | undefined>;
  getAll?(): Promise<readonly { readonly name: string }[]>;
  create(
    name: string,
    alarmInfo: { readonly when: number },
  ): void | Promise<void>;
  clear(name: string): Promise<boolean>;
}

export interface NotesReminderStoreDependencies {
  readonly storage: StorageAreaLike;
  readonly alarms: AlarmStoreLike;
  readonly now: () => Date;
  readonly createId: () => string;
}

export interface ReminderDeliveryOptions {
  /**
   * Create or replace the stable notification before the record is marked.
   * A retry can safely replace the same notification if the worker stopped
   * between these two steps.
   */
  readonly onDue?: (reminder: ReminderRecord) => void | Promise<void>;
  readonly now?: Date;
}

export interface ReminderReconciliation {
  readonly delivered: readonly ReminderRecord[];
  readonly recreatedAlarmNames: readonly string[];
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const NOTE_KEYS = [
  "id",
  "body",
  "tag",
  "createdAt",
  "updatedAt",
  "source",
] as const;
const SOURCE_KEYS = ["title", "url"] as const;
const REMINDER_KEYS = [
  "id",
  "noteId",
  "text",
  "dueAt",
  "status",
  "alarmName",
  "sourceTabId",
  "sourceWindowId",
] as const;

function defaultStorage(): StorageAreaLike {
  return {
    get: async (keys) => {
      if (keys === undefined) return chrome.storage.local.get(null);
      return chrome.storage.local.get(keys as string | string[] | null);
    },
    set: (items) => chrome.storage.local.set(items),
    remove: (keys) => chrome.storage.local.remove(keys as string | string[]),
    setAccessLevel: (options) =>
      chrome.storage.local.setAccessLevel(options),
  };
}

function defaultAlarms(): AlarmStoreLike {
  return {
    get: (name) => chrome.alarms.get(name),
    getAll: () => chrome.alarms.getAll(),
    create: (name, alarmInfo) => chrome.alarms.create(name, alarmInfo),
    clear: (name) => chrome.alarms.clear(name),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isCanonicalIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

function isOptionalInteger(value: unknown): boolean {
  return value === undefined || (Number.isInteger(value) && (value as number) >= 0);
}

function isQuotaBytesError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    /QUOTA_BYTES(?:_PER_ITEM)?/i.test(`${error.name} ${error.message}`) ||
    error.name === "QuotaExceededError"
  );
}

function recordsMatch(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function isNoteRecord(value: unknown): value is NoteRecord {
  if (!isRecord(value) || !hasOnlyKeys(value, NOTE_KEYS)) return false;
  if (
    !isId(value.id) ||
    typeof value.body !== "string" ||
    value.body.length < 1 ||
    value.body.length > MAX_NOTE_BODY_LENGTH ||
    (
      value.tag !== undefined &&
      (
        typeof value.tag !== "string" ||
        value.tag.length < 1 ||
        value.tag.length > MAX_NOTE_TAG_LENGTH ||
        value.tag !== normalizeNoteTag(value.tag)
      )
    ) ||
    !isCanonicalIsoDate(value.createdAt) ||
    !isCanonicalIsoDate(value.updatedAt)
  ) {
    return false;
  }

  if (value.source === undefined) return true;
  return (
    isRecord(value.source) &&
    hasOnlyKeys(value.source, SOURCE_KEYS) &&
    typeof value.source.title === "string" &&
    typeof value.source.url === "string"
  );
}

export function isReminderRecord(value: unknown): value is ReminderRecord {
  if (!isRecord(value) || !hasOnlyKeys(value, REMINDER_KEYS)) return false;
  return (
    isId(value.id) &&
    (value.noteId === undefined || isId(value.noteId)) &&
    typeof value.text === "string" &&
    value.text.length >= 1 &&
    value.text.length <= MAX_REMINDER_TEXT_LENGTH &&
    isCanonicalIsoDate(value.dueAt) &&
    (value.status === "scheduled" ||
      value.status === "delivered" ||
      value.status === "dismissed") &&
    value.alarmName === `${REMINDER_KEY_PREFIX}${value.id}` &&
    isOptionalInteger(value.sourceTabId) &&
    isOptionalInteger(value.sourceWindowId)
  );
}

function validateText(value: string, label: string, maximum: number): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new TypeError(`${label} must not be empty`);
  }
  if (normalized.length > maximum) {
    throw new TypeError(`${label} must contain at most ${maximum} characters`);
  }
  return normalized;
}

export function parseReminderDelayMinutes(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError("Reminder delay must be a finite number of minutes");
  }
  if (value < MIN_REMINDER_DELAY_MINUTES) {
    throw new RangeError("Reminder delay must be at least 0.5 minutes");
  }
  if (value > MAX_REMINDER_DELAY_MINUTES) {
    throw new RangeError(
      `Reminder delay must be at most ${MAX_REMINDER_DELAY_MINUTES} minutes`,
    );
  }
  return value;
}

function assertSchemaVersion(
  values: Record<string, unknown>,
  hasVersionedRecords: boolean,
): void {
  const version = values[NOTES_SCHEMA_VERSION_KEY];
  if (version === undefined && !hasVersionedRecords) return;
  if (version !== NOTES_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported notes schema version: ${String(version)}`,
    );
  }
}

function readNotes(values: Record<string, unknown>): NoteRecord[] {
  const entries = Object.entries(values).filter(([key]) =>
    key.startsWith(NOTE_KEY_PREFIX),
  );
  assertSchemaVersion(values, entries.length > 0);

  return entries.map(([key, value]) => {
    if (!isNoteRecord(value) || key !== `${NOTE_KEY_PREFIX}${value.id}`) {
      throw new Error(`Invalid note record at ${key}`);
    }
    return value;
  });
}

function readReminders(values: Record<string, unknown>): ReminderRecord[] {
  const entries = Object.entries(values).filter(([key]) =>
    key.startsWith(REMINDER_KEY_PREFIX),
  );
  assertSchemaVersion(values, entries.length > 0);

  return entries.map(([key, value]) => {
    if (
      !isReminderRecord(value) ||
      key !== `${REMINDER_KEY_PREFIX}${value.id}`
    ) {
      throw new Error(`Invalid reminder record at ${key}`);
    }
    return value;
  });
}

function validGeneratedId(createId: () => string): string {
  const id = createId();
  if (!isId(id)) throw new Error("Generated an invalid notes record id");
  return id;
}

export class NotesReminderStore {
  readonly #storage: StorageAreaLike;
  readonly #alarms: AlarmStoreLike;
  readonly #now: () => Date;
  readonly #createId: () => string;
  #mutationTail: Promise<void> = Promise.resolve();

  constructor(
    dependencies: Partial<NotesReminderStoreDependencies> = {},
  ) {
    this.#storage = dependencies.storage ?? defaultStorage();
    this.#alarms = dependencies.alarms ?? defaultAlarms();
    this.#now = dependencies.now ?? (() => new Date());
    this.#createId =
      dependencies.createId ?? (() => crypto.randomUUID());
  }

  #enqueueMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const task = this.#mutationTail.then(mutation, mutation);
    this.#mutationTail = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  async #set(items: Record<string, unknown>): Promise<void> {
    try {
      await this.#storage.set(items);
    } catch (error) {
      if (isQuotaBytesError(error)) {
        throw new NotesStorageUserError(STORAGE_FULL_MESSAGE);
      }
      throw error;
    }
  }

  async #remove(keys: string | readonly string[]): Promise<void> {
    try {
      await this.#storage.remove(keys);
    } catch (error) {
      if (isQuotaBytesError(error)) {
        throw new NotesStorageUserError(STORAGE_FULL_MESSAGE);
      }
      throw error;
    }
  }

  async #createRecord(
    key: string,
    record: NoteRecord | ReminderRecord,
  ): Promise<void> {
    const before = await this.#storage.get([
      NOTES_SCHEMA_VERSION_KEY,
      key,
    ]);
    assertSchemaVersion(before, before[key] !== undefined);
    if (before[key] !== undefined) {
      throw new Error(`Record already exists at ${key}`);
    }
    const hadSchemaVersion =
      before[NOTES_SCHEMA_VERSION_KEY] !== undefined;
    const cleanupKeys = hadSchemaVersion
      ? key
      : [NOTES_SCHEMA_VERSION_KEY, key];

    try {
      await this.#set({
        [NOTES_SCHEMA_VERSION_KEY]: NOTES_SCHEMA_VERSION,
        [key]: record,
      });
    } catch (error) {
      await this.#remove(cleanupKeys).catch(() => undefined);
      throw error;
    }

    const saved = await this.#storage.get([
      NOTES_SCHEMA_VERSION_KEY,
      key,
    ]);
    if (
      saved[NOTES_SCHEMA_VERSION_KEY] !== NOTES_SCHEMA_VERSION ||
      !recordsMatch(saved[key], record)
    ) {
      await this.#remove(cleanupKeys);
      throw new Error(`Storage did not save a complete record at ${key}`);
    }
  }

  async #updateRecord(
    key: string,
    record: NoteRecord | ReminderRecord,
  ): Promise<void> {
    await this.#set({ [key]: record });
  }

  async #unusedId(prefix: string): Promise<string> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const id = validGeneratedId(this.#createId);
      const key = `${prefix}${id}`;
      const values = await this.#storage.get([
        NOTES_SCHEMA_VERSION_KEY,
        key,
      ]);
      assertSchemaVersion(values, values[key] !== undefined);
      const existing = values[key];
      if (existing === undefined) return id;
      const valid =
        prefix === NOTE_KEY_PREFIX
          ? isNoteRecord(existing) &&
            key === `${NOTE_KEY_PREFIX}${existing.id}`
          : isReminderRecord(existing) &&
            key === `${REMINDER_KEY_PREFIX}${existing.id}`;
      if (!valid) throw new Error(`Invalid record at ${key}`);
    }
    throw new Error("Could not allocate a unique notes record id");
  }

  createNote(input: CreateNoteInput): Promise<NoteRecord> {
    return this.#enqueueMutation(async () => {
      const body = validateText(
        input.body,
        "Note body",
        MAX_NOTE_BODY_LENGTH,
      );
      const tag = input.tag === undefined
        ? undefined
        : normalizeNoteTag(input.tag);
      if (tag !== undefined && tag.length === 0) {
        throw new TypeError("Note tag must not be empty");
      }
      if (tag !== undefined && tag.length > MAX_NOTE_TAG_LENGTH) {
        throw new TypeError(
          `Note tag must contain at most ${MAX_NOTE_TAG_LENGTH} characters`,
        );
      }
      const notes = readNotes(await this.#storage.get(null));
      if (notes.length >= MAX_NOTES) {
        throw new NotesStorageUserError(NOTES_CAP_MESSAGE);
      }
      const id = await this.#unusedId(NOTE_KEY_PREFIX);
      const timestamp = this.#now().toISOString();
      const note: NoteRecord = {
        id,
        body,
        ...(tag === undefined ? {} : { tag }),
        createdAt: timestamp,
        updatedAt: timestamp,
        ...(input.source === undefined
          ? {}
          : {
            source: {
              title: input.source.title,
              url: input.source.url,
            },
          }),
      };

      await this.#createRecord(`${NOTE_KEY_PREFIX}${id}`, note);
      return note;
    });
  }

  async listNotes(): Promise<readonly NoteRecord[]> {
    const notes = readNotes(await this.#storage.get(null));
    return notes.sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt),
    );
  }

  deleteNote(noteId: string): Promise<boolean> {
    return this.#enqueueMutation(async () => {
      if (!isId(noteId)) {
        throw new TypeError("A valid note id is required");
      }
      const key = `${NOTE_KEY_PREFIX}${noteId}`;
      const values = await this.#storage.get([
        NOTES_SCHEMA_VERSION_KEY,
        key,
      ]);
      assertSchemaVersion(values, values[key] !== undefined);
      const note = values[key];
      if (note === undefined) return false;
      if (!isNoteRecord(note) || note.id !== noteId) {
        throw new Error(`Invalid note record at ${key}`);
      }
      await this.#remove(key);
      return true;
    });
  }

  deleteLastNote(): Promise<NoteRecord | undefined> {
    return this.#enqueueMutation(async () => {
      const notes = readNotes(await this.#storage.get(null));
      notes.sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt),
      );
      const note = notes[0];
      if (!note) return undefined;
      await this.#remove(`${NOTE_KEY_PREFIX}${note.id}`);
      return note;
    });
  }

  async listReminders(): Promise<readonly ReminderRecord[]> {
    const reminders = readReminders(await this.#storage.get(null));
    return reminders.sort((left, right) =>
      left.dueAt.localeCompare(right.dueAt),
    );
  }

  async listPendingReminders(): Promise<readonly ReminderRecord[]> {
    return (await this.listReminders()).filter(
      (reminder) => reminder.status === "scheduled",
    );
  }

  cancelReminder(reminderId: string): Promise<boolean> {
    return this.#enqueueMutation(async () => {
      if (!isId(reminderId)) {
        throw new TypeError("A valid reminder id is required");
      }
      const key = `${REMINDER_KEY_PREFIX}${reminderId}`;
      const values = await this.#storage.get([
        NOTES_SCHEMA_VERSION_KEY,
        key,
      ]);
      assertSchemaVersion(values, values[key] !== undefined);
      const reminder = values[key];
      if (reminder === undefined) return false;
      if (!isReminderRecord(reminder) || reminder.id !== reminderId) {
        throw new Error(`Invalid reminder record at ${key}`);
      }
      if (reminder.status !== "scheduled") return false;

      await this.#remove(key);
      try {
        await this.#alarms.clear(reminder.alarmName);
      } catch {
        // Storage is authoritative. Reconciliation clears a stray alarm.
      }
      return true;
    });
  }

  snoozeReminder(
    reminderId: string,
    delayMinutes: number,
  ): Promise<ReminderRecord | undefined> {
    return this.#enqueueMutation(async () => {
      if (!isId(reminderId)) {
        throw new TypeError("A valid reminder id is required");
      }
      const delay = parseReminderDelayMinutes(delayMinutes);
      const key = `${REMINDER_KEY_PREFIX}${reminderId}`;
      const values = await this.#storage.get([
        NOTES_SCHEMA_VERSION_KEY,
        key,
      ]);
      assertSchemaVersion(values, values[key] !== undefined);
      const reminder = values[key];
      if (reminder === undefined) return undefined;
      if (!isReminderRecord(reminder) || reminder.id !== reminderId) {
        throw new Error(`Invalid reminder record at ${key}`);
      }
      if (reminder.status !== "delivered") return undefined;

      const snoozed: ReminderRecord = {
        ...reminder,
        dueAt: new Date(
          this.#now().getTime() + delay * 60_000,
        ).toISOString(),
        status: "scheduled",
      };

      // Storage is authoritative. Save the new time before the disposable
      // alarm registry entry.
      await this.#updateRecord(key, snoozed);
      try {
        await this.#alarms.create(snoozed.alarmName, {
          when: Date.parse(snoozed.dueAt),
        });
      } catch (error) {
        try {
          await this.#updateRecord(key, reminder);
        } catch {
          // Do not leave a failed snooze ready for later reconciliation.
          await this.#remove(key).catch(() => undefined);
        }
        throw error;
      }
      return snoozed;
    });
  }

  scheduleReminder(input: ScheduleReminderInput): Promise<ReminderRecord> {
    return this.#enqueueMutation(async () => {
      const delayMinutes = parseReminderDelayMinutes(input.delayMinutes);
      const text = validateText(
        input.text,
        "Reminder text",
        MAX_REMINDER_TEXT_LENGTH,
      );
      const pendingCount = readReminders(
        await this.#storage.get(null),
      ).filter((reminder) => reminder.status === "scheduled").length;
      if (pendingCount >= MAX_PENDING_REMINDERS) {
        throw new NotesStorageUserError(REMINDERS_CAP_MESSAGE);
      }
      const id = await this.#unusedId(REMINDER_KEY_PREFIX);
      const alarmName = `${REMINDER_KEY_PREFIX}${id}`;
      const dueAt = new Date(
        this.#now().getTime() + delayMinutes * 60_000,
      ).toISOString();
      const reminder: ReminderRecord = {
        id,
        text,
        dueAt,
        status: "scheduled",
        alarmName,
        ...(input.noteId === undefined ? {} : { noteId: input.noteId }),
        ...(input.sourceTabId === undefined
          ? {}
          : { sourceTabId: input.sourceTabId }),
        ...(input.sourceWindowId === undefined
          ? {}
          : { sourceWindowId: input.sourceWindowId }),
      };
      if (!isReminderRecord(reminder)) {
        throw new TypeError("Reminder input is invalid");
      }

      // Storage is authoritative, so persist before creating the disposable
      // alarm registry entry.
      const key = `${REMINDER_KEY_PREFIX}${id}`;
      await this.#createRecord(key, reminder);
      try {
        await this.#alarms.create(alarmName, {
          when: Date.parse(reminder.dueAt),
        });
      } catch (error) {
        // Do not leave a failed command scheduled for a later worker restart.
        await this.#remove(key);
        throw error;
      }
      return reminder;
    });
  }

  reconcileReminders(
    options: ReminderDeliveryOptions = {},
  ): Promise<ReminderReconciliation> {
    return this.#enqueueMutation(async () => {
      const now = options.now ?? this.#now();
      const reminders = readReminders(await this.#storage.get(null));
      const delivered: ReminderRecord[] = [];
      const recreatedAlarmNames: string[] = [];

      for (const reminder of reminders) {
        if (reminder.status !== "scheduled") continue;

        if (Date.parse(reminder.dueAt) <= now.getTime()) {
          try {
            await options.onDue?.(reminder);
          } catch (error) {
            await this.#alarms.create(reminder.alarmName, {
              when: now.getTime() + REMINDER_DELIVERY_RETRY_MS,
            });
            throw error;
          }
          const deliveredReminder: ReminderRecord = {
            ...reminder,
            status: "delivered",
          };
          await this.#updateRecord(
            `${REMINDER_KEY_PREFIX}${reminder.id}`,
            deliveredReminder,
          );
          delivered.push(deliveredReminder);
          await this.#alarms.clear(reminder.alarmName);
          continue;
        }

        const alarm = await this.#alarms.get(reminder.alarmName);
        if (!alarm) {
          await this.#alarms.create(reminder.alarmName, {
            when: Date.parse(reminder.dueAt),
          });
          recreatedAlarmNames.push(reminder.alarmName);
        }
      }

      const scheduledAlarmNames = new Set(
        reminders
          .filter((reminder) => reminder.status === "scheduled")
          .map((reminder) => reminder.alarmName),
      );
      for (const alarm of await this.#alarms.getAll?.() ?? []) {
        if (
          alarm.name.startsWith(REMINDER_KEY_PREFIX) &&
          !scheduledAlarmNames.has(alarm.name)
        ) {
          await this.#alarms.clear(alarm.name);
        }
      }

      return { delivered, recreatedAlarmNames };
    });
  }

  handleReminderAlarm(
    alarmName: string,
    options: ReminderDeliveryOptions = {},
  ): Promise<ReminderRecord | undefined> {
    return this.#enqueueMutation(async () => {
      if (!alarmName.startsWith(REMINDER_KEY_PREFIX)) return undefined;
      const values = await this.#storage.get([
        NOTES_SCHEMA_VERSION_KEY,
        alarmName,
      ]);
      const raw = values[alarmName];
      assertSchemaVersion(values, raw !== undefined);
      if (raw === undefined) return undefined;
      if (!isReminderRecord(raw) || raw.alarmName !== alarmName) {
        throw new Error(`Invalid reminder record at ${alarmName}`);
      }
      if (raw.status !== "scheduled") return undefined;

      const now = options.now ?? this.#now();
      if (Date.parse(raw.dueAt) > now.getTime()) {
        await this.#alarms.create(raw.alarmName, {
          when: Date.parse(raw.dueAt),
        });
        return undefined;
      }

      try {
        await options.onDue?.(raw);
      } catch (error) {
        await this.#alarms.create(raw.alarmName, {
          when: now.getTime() + REMINDER_DELIVERY_RETRY_MS,
        });
        throw error;
      }
      const delivered: ReminderRecord = {
        ...raw,
        status: "delivered",
      };
      await this.#updateRecord(alarmName, delivered);
      return delivered;
    });
  }
}

export async function restrictNotesStorageAccess(
  storage: StorageAreaLike = defaultStorage(),
): Promise<void> {
  if (!storage.setAccessLevel) {
    throw new Error("Storage area does not support access-level restriction");
  }
  await storage.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
}

export const notesReminderStore = new NotesReminderStore();
