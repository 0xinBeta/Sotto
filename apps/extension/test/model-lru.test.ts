import { afterEach, describe, expect, it, vi } from "vitest";

import { ModelResidencyLru } from "../src/model-lru.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ModelResidencyLru", () => {
  it("releases only idle resident models after memory pressure and supports cache reload", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const sttRelease = vi.fn().mockResolvedValue(undefined);
    const ttsRelease = vi.fn().mockResolvedValue(undefined);
    const lru = new ModelResidencyLru({ idleMs: 100 });
    lru.register("premium-stt", sttRelease);
    lru.register("premium-tts", ttsRelease);
    lru.markResident("premium-stt");
    vi.setSystemTime(10);
    lru.markResident("premium-tts");

    await vi.advanceTimersByTimeAsync(200);
    expect(sttRelease).not.toHaveBeenCalled();
    expect(ttsRelease).not.toHaveBeenCalled();

    lru.noteMemoryPressure();
    await vi.runOnlyPendingTimersAsync();

    expect(sttRelease).toHaveBeenCalledTimes(1);
    expect(ttsRelease).toHaveBeenCalledTimes(1);
    expect(lru.isResident("premium-stt")).toBe(false);

    vi.setSystemTime(300);
    lru.markResident("premium-stt");
    expect(lru.isResident("premium-stt")).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(sttRelease).toHaveBeenCalledTimes(2);
    lru.dispose();
  });

  it("evicts the least-recently-used peer immediately for one allocation retry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const sttRelease = vi.fn().mockResolvedValue(undefined);
    const ttsRelease = vi.fn().mockResolvedValue(undefined);
    const lru = new ModelResidencyLru({ idleMs: 1_000 });
    lru.register("premium-stt", sttRelease);
    lru.register("premium-tts", ttsRelease);
    lru.markResident("premium-tts");
    vi.setSystemTime(50);
    lru.markResident("premium-stt");

    await expect(
      lru.evictLeastRecentlyUsed("premium-stt"),
    ).resolves.toBe("premium-tts");
    expect(ttsRelease).toHaveBeenCalledTimes(1);
    expect(sttRelease).not.toHaveBeenCalled();
    lru.dispose();
  });
});
