import { describe, expect, it, vi } from "vitest";

import {
  SESSION_HISTORY_LIMIT,
  SESSION_HISTORY_STORAGE_KEY,
  SessionHistoryStore,
  type SessionHistoryStorage,
} from "../src/session-history.js";

function harness(initial?: unknown): {
  readonly store: SessionHistoryStore;
  readonly values: Record<string, unknown>;
  readonly set: ReturnType<typeof vi.fn>;
  readonly remove: ReturnType<typeof vi.fn>;
} {
  const values: Record<string, unknown> =
    initial === undefined
      ? {}
      : { [SESSION_HISTORY_STORAGE_KEY]: initial };
  const set = vi.fn(async (updates: Readonly<Record<string, unknown>>) => {
    Object.assign(values, updates);
  });
  const remove = vi.fn(async (key: string) => {
    delete values[key];
  });
  const storage: SessionHistoryStorage = {
    get: vi.fn(async (key) =>
      Object.hasOwn(values, key) ? { [key]: values[key] } : {}
    ),
    set,
    remove,
  };
  return {
    store: new SessionHistoryStore(storage),
    values,
    set,
    remove,
  };
}

describe("session history", () => {
  it("does not write entries before the user opts in", async () => {
    const { store, set, remove, values } = harness();

    const result = await store.append(
      "open a new tab",
      "tabs",
      "Opened a new tab.",
    );

    expect(result).toBeUndefined();
    expect(set).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(values).toEqual({});
  });

  it("stores only the exact history entry shape", async () => {
    const { store, values } = harness();
    await store.setEnabled(true);

    const result = await store.append(
      "summarize this page",
      "summarize",
      "Here is the summary.",
      new Date("2026-07-29T10:20:30.000Z"),
    );
    const saved = values[SESSION_HISTORY_STORAGE_KEY] as {
      readonly entries: readonly Record<string, unknown>[];
    };

    expect(result?.entry).toEqual({
      timestamp: "2026-07-29T10:20:30.000Z",
      transcript: "summarize this page",
      actionId: "summarize",
      resultLine: "Here is the summary.",
    });
    expect(Object.keys(saved.entries[0]!)).toEqual([
      "timestamp",
      "transcript",
      "actionId",
      "resultLine",
    ]);
    expect(saved.entries[0]).not.toHaveProperty("pageText");
    expect(saved.entries[0]).not.toHaveProperty("pageTitle");
    expect(saved.entries[0]).not.toHaveProperty("url");
    expect(saved.entries[0]).not.toHaveProperty("modelOutput");
  });

  it("keeps the newest 200 entries", async () => {
    const { store } = harness();
    await store.setEnabled(true);

    for (let index = 0; index < SESSION_HISTORY_LIMIT + 5; index += 1) {
      await store.append(
        `command ${index}`,
        "test",
        `result ${index}`,
        new Date(1_700_000_000_000 + index),
      );
    }

    const state = await store.get();
    expect(state.entries).toHaveLength(SESSION_HISTORY_LIMIT);
    expect(state.entries[0]?.transcript).toBe("command 5");
    expect(state.entries.at(-1)?.transcript).toBe("command 204");
  });

  it("wipes entries when the user turns history off", async () => {
    const { store, values, remove } = harness();
    await store.setEnabled(true);
    await store.append("close this tab", "tabs", "Closed the tab.");

    const state = await store.setEnabled(false);

    expect(state).toEqual({ enabled: false, entries: [] });
    expect(remove).toHaveBeenCalledWith(SESSION_HISTORY_STORAGE_KEY);
    expect(values).toEqual({});
    expect(await store.get()).toEqual({ enabled: false, entries: [] });
  });
});
