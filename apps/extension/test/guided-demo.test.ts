import { describe, expect, it, vi } from "vitest";

import {
  GUIDED_DEMO_RETIRED_KEY,
  GUIDED_DEMO_STARTER_INDEX_KEY,
  GuidedDemoStore,
  shouldShowGuidedDemo,
  type GuidedDemoStorage,
} from "../src/guided-demo.js";

class MemoryStorage implements GuidedDemoStorage {
  readonly set = vi.fn(async (updates: Record<string, unknown>) => {
    Object.assign(this.values, updates);
  });

  constructor(readonly values: Record<string, unknown> = {}) {}

  async get(keys: readonly string[]): Promise<Record<string, unknown>> {
    return Object.fromEntries(
      keys
        .filter((key) => key in this.values)
        .map((key) => [key, this.values[key]]),
    );
  }
}

describe("guided try-it demo", () => {
  it("shows only after required setup and before retirement", () => {
    expect(shouldShowGuidedDemo(false, false)).toBe(false);
    expect(shouldShowGuidedDemo(true, false)).toBe(true);
    expect(shouldShowGuidedDemo(true, true)).toBe(false);
  });

  it("rotates through all starters on panel open", async () => {
    const storage = new MemoryStorage();
    const store = new GuidedDemoStore(storage);

    await expect(store.open()).resolves.toMatchObject({
      starter: "guidedDemoScreenshot",
    });
    await expect(store.open()).resolves.toMatchObject({
      starter: "guidedDemoTabCount",
    });
    await expect(store.open()).resolves.toMatchObject({
      starter: "guidedDemoSummary",
    });
    await expect(store.open()).resolves.toMatchObject({
      starter: "guidedDemoScreenshot",
    });
    expect(storage.values[GUIDED_DEMO_STARTER_INDEX_KEY]).toBe(0);
  });

  it("persists retirement across store instances", async () => {
    const storage = new MemoryStorage();
    await new GuidedDemoStore(storage).retire();

    expect(storage.values[GUIDED_DEMO_RETIRED_KEY]).toBe(true);
    await expect(new GuidedDemoStore(storage).open()).resolves.toEqual({
      retired: true,
      starter: "guidedDemoScreenshot",
    });
    expect(storage.set).toHaveBeenCalledOnce();
  });
});
