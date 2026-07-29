import { describe, expect, it, vi } from "vitest";

import {
  QUIET_MODE_KEY,
  QuietModeStore,
  normalizeQuietMode,
  type QuietModeStorage,
} from "../src/quiet-mode.js";

function storageHarness(
  initial: Record<string, unknown> = {},
): {
  readonly storage: QuietModeStorage;
  readonly values: Record<string, unknown>;
  readonly set: ReturnType<typeof vi.fn>;
} {
  const values = { ...initial };
  const set = vi.fn(async (updates: Record<string, unknown>) => {
    Object.assign(values, updates);
  });
  return {
    values,
    set,
    storage: {
      get: vi.fn(async (key: string) =>
        key in values ? { [key]: values[key] } : {}
      ),
      set,
    },
  };
}

describe("quiet mode", () => {
  it("restores the persisted state and rejects non-boolean values", async () => {
    const persisted = storageHarness({ [QUIET_MODE_KEY]: true });
    await expect(
      new QuietModeStore(persisted.storage).get(),
    ).resolves.toBe(true);

    expect(normalizeQuietMode({ [QUIET_MODE_KEY]: "true" })).toBe(false);
  });

  it("persists each state change", async () => {
    const harness = storageHarness();
    const store = new QuietModeStore(harness.storage);

    await expect(store.update(true)).resolves.toBe(true);
    expect(harness.values[QUIET_MODE_KEY]).toBe(true);
    expect(harness.set).toHaveBeenLastCalledWith({
      [QUIET_MODE_KEY]: true,
    });

    await expect(store.update(false)).resolves.toBe(false);
    expect(harness.values[QUIET_MODE_KEY]).toBe(false);
  });
});
