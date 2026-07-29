export const SESSION_HISTORY_LIMIT = 200;
export const SESSION_HISTORY_STORAGE_KEY = "sessionHistory";

const MAX_TRANSCRIPT_LENGTH = 2_000;
const MAX_ACTION_ID_LENGTH = 100;
const MAX_RESULT_LINE_LENGTH = 2_000;

export interface SessionHistoryEntry {
  readonly timestamp: string;
  readonly transcript: string;
  readonly actionId: string;
  readonly resultLine: string;
}

export interface SessionHistoryState {
  readonly enabled: boolean;
  readonly entries: readonly SessionHistoryEntry[];
}

export interface SessionHistoryAppend {
  readonly entry: SessionHistoryEntry;
  readonly count: number;
}

export interface SessionHistoryStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(values: Readonly<Record<string, unknown>>): Promise<void>;
  remove(key: string): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function oneLine(value: string, maximum: number): string {
  const line = value.replace(/\s+/gu, " ").trim().slice(0, maximum);
  if (!line) throw new TypeError("Session history text must not be empty");
  return line;
}

function isSessionHistoryEntry(value: unknown): value is SessionHistoryEntry {
  if (!isRecord(value)) return false;
  return (
    Object.keys(value).length === 4 &&
    Object.hasOwn(value, "timestamp") &&
    Object.hasOwn(value, "transcript") &&
    Object.hasOwn(value, "actionId") &&
    Object.hasOwn(value, "resultLine") &&
    typeof value.timestamp === "string" &&
    value.timestamp.length <= 35 &&
    Number.isFinite(Date.parse(value.timestamp)) &&
    typeof value.transcript === "string" &&
    value.transcript.length >= 1 &&
    value.transcript.length <= MAX_TRANSCRIPT_LENGTH &&
    typeof value.actionId === "string" &&
    value.actionId.length >= 1 &&
    value.actionId.length <= MAX_ACTION_ID_LENGTH &&
    typeof value.resultLine === "string" &&
    value.resultLine.length >= 1 &&
    value.resultLine.length <= MAX_RESULT_LINE_LENGTH
  );
}

function readState(value: unknown): SessionHistoryState {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    value.enabled !== true ||
    !Array.isArray(value.entries) ||
    !value.entries.every(isSessionHistoryEntry)
  ) {
    return { enabled: false, entries: [] };
  }
  return {
    enabled: true,
    entries: value.entries.slice(-SESSION_HISTORY_LIMIT).map((entry) => ({
      ...entry,
    })),
  };
}

function storedState(
  entries: readonly SessionHistoryEntry[],
): Readonly<Record<string, unknown>> {
  return {
    [SESSION_HISTORY_STORAGE_KEY]: {
      enabled: true,
      entries,
    },
  };
}

export class SessionHistoryStore {
  #tail: Promise<void> = Promise.resolve();

  constructor(private readonly storage: SessionHistoryStorage) {}

  get(): Promise<SessionHistoryState> {
    return this.#enqueue(async () => this.#read());
  }

  setEnabled(enabled: boolean): Promise<SessionHistoryState> {
    return this.#enqueue(async () => {
      if (!enabled) {
        await this.storage.remove(SESSION_HISTORY_STORAGE_KEY);
        return { enabled: false, entries: [] };
      }
      const state = await this.#read();
      const next = {
        enabled: true,
        entries: state.enabled ? state.entries : [],
      } as const;
      await this.storage.set(storedState(next.entries));
      return next;
    });
  }

  clear(): Promise<SessionHistoryState> {
    return this.#enqueue(async () => {
      const state = await this.#read();
      if (!state.enabled) {
        await this.storage.remove(SESSION_HISTORY_STORAGE_KEY);
        return { enabled: false, entries: [] };
      }
      const next = { enabled: true, entries: [] } as const;
      await this.storage.set(storedState(next.entries));
      return next;
    });
  }

  append(
    transcript: string,
    actionId: string,
    resultLine: string,
    timestamp: Date = new Date(),
  ): Promise<SessionHistoryAppend | undefined> {
    return this.#enqueue(async () => {
      const state = await this.#read();
      if (!state.enabled) return undefined;

      const entry: SessionHistoryEntry = {
        timestamp: timestamp.toISOString(),
        transcript: oneLine(transcript, MAX_TRANSCRIPT_LENGTH),
        actionId: oneLine(actionId, MAX_ACTION_ID_LENGTH),
        resultLine: oneLine(resultLine, MAX_RESULT_LINE_LENGTH),
      };
      const entries = [...state.entries, entry].slice(-SESSION_HISTORY_LIMIT);
      await this.storage.set(storedState(entries));
      return { entry, count: entries.length };
    });
  }

  #enqueue<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.#tail.then(operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #read(): Promise<SessionHistoryState> {
    const values = await this.storage.get(SESSION_HISTORY_STORAGE_KEY);
    return readState(values[SESSION_HISTORY_STORAGE_KEY]);
  }
}
