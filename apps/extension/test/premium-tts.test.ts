import { afterEach, describe, expect, it, vi } from "vitest";

import { InferenceMutex } from "../src/inference-mutex.js";
import {
  PREMIUM_FIRST_AUDIO_TIMEOUT_MS,
  PremiumTtsRouter,
  premiumEnabledByDefault,
  splitPremiumSentences,
  type PremiumTtsRequest,
} from "../src/premium-tts.js";

function systemHarness() {
  return {
    speak: vi.fn().mockResolvedValue(undefined),
    speakLong: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("PremiumTtsRouter", () => {
  it("uses system TTS immediately while premium is absent or downloading", async () => {
    const system = systemHarness();
    const request = vi.fn().mockResolvedValue(undefined);
    const router = new PremiumTtsRouter({ system, request });

    router.updateStatus({ state: "absent", enabled: false });
    await router.speak("Immediate fallback.");
    router.updateStatus({ state: "downloading", enabled: true });
    await router.speak("Still immediate.");

    expect(system.speak).toHaveBeenNthCalledWith(1, "Immediate fallback.", {});
    expect(system.speak).toHaveBeenNthCalledWith(2, "Still immediate.", {});
    expect(
      request.mock.calls.some(
        ([call]) => (call as PremiumTtsRequest).type === "premium-speak",
      ),
    ).toBe(false);
  });

  it("falls back at 750 ms when premium has not produced first audio", async () => {
    vi.useFakeTimers();
    const system = systemHarness();
    const never = new Promise<unknown>(() => undefined);
    const request = vi.fn((message: PremiumTtsRequest) =>
      message.type === "premium-speak"
        ? never
        : Promise.resolve(undefined)
    );
    const router = new PremiumTtsRouter({ system, request });
    router.updateStatus({ state: "ready", enabled: true });

    const speaking = router.speak("Deadline.");
    await vi.advanceTimersByTimeAsync(PREMIUM_FIRST_AUDIO_TIMEOUT_MS - 1);
    expect(system.speak).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await speaking;

    expect(system.speak).toHaveBeenCalledWith("Deadline.", {});
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ type: "premium-stop" }),
    );
  });

  it("opens after two consecutive failures and closes after an idle probe", async () => {
    vi.useFakeTimers();
    const system = systemHarness();
    let premiumAttempts = 0;
    const request = vi.fn(async (message: PremiumTtsRequest) => {
      if (message.type === "premium-speak") {
        premiumAttempts += 1;
        throw new Error("premium failed");
      }
      return undefined;
    });
    const router = new PremiumTtsRouter({
      system,
      request,
      retryDelayMs: 20,
    });
    router.updateStatus({ state: "ready", enabled: true });

    await router.speak("Failure one.");
    await router.speak("Failure two.");
    expect(router.circuitOpen).toBe(true);
    expect(router.consecutiveFailures).toBe(2);

    await router.speak("Circuit fallback.");
    expect(premiumAttempts).toBe(2);
    expect(system.speak).toHaveBeenCalledWith("Circuit fallback.", {});

    await vi.advanceTimersByTimeAsync(20);
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith({ type: "premium-probe" }),
    );
    expect(router.circuitOpen).toBe(false);
    expect(router.consecutiveFailures).toBe(0);
  });

  it("cancels premium playback immediately on barge-in", async () => {
    const system = systemHarness();
    const never = new Promise<unknown>(() => undefined);
    let utteranceId = "";
    const request = vi.fn((message: PremiumTtsRequest) => {
      if (message.type === "premium-speak") {
        utteranceId = message.utteranceId ?? "";
        return never;
      }
      return Promise.resolve(undefined);
    });
    const router = new PremiumTtsRouter({ system, request });
    router.updateStatus({ state: "ready", enabled: true });

    const speaking = router.speak("Long response.");
    await vi.waitFor(() => expect(utteranceId).not.toBe(""));
    router.notifyFirstAudio(utteranceId);
    router.stop();
    await speaking;

    expect(system.stop).toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith({ type: "premium-stop" });
    expect(system.speak).not.toHaveBeenCalled();
  });

  it("keeps long-form engine decisions at sentence boundaries", async () => {
    const system = systemHarness();
    let router!: PremiumTtsRouter;
    let attempt = 0;
    const request = vi.fn(async (message: PremiumTtsRequest) => {
      if (message.type !== "premium-speak") return;
      attempt += 1;
      if (attempt === 1) throw new Error("first sentence failed");
      queueMicrotask(() =>
        router.notifyFirstAudio(message.utteranceId ?? "")
      );
    });
    router = new PremiumTtsRouter({ system, request });
    router.updateStatus({ state: "ready", enabled: true });

    await router.speakLong("First sentence. Second sentence.");

    expect(system.speak).toHaveBeenCalledWith("First sentence.", {});
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "premium-speak",
        text: "Second sentence.",
      }),
    );
    expect(
      splitPremiumSentences("First sentence. Second sentence."),
    ).toEqual(["First sentence.", "Second sentence."]);
  });
});

describe("premium voice settings", () => {
  it("defaults ON only after a successful download and preserves explicit choice", () => {
    expect(premiumEnabledByDefault(undefined, false)).toBe(false);
    expect(premiumEnabledByDefault(undefined, true)).toBe(true);
    expect(premiumEnabledByDefault(false, true)).toBe(false);
    expect(premiumEnabledByDefault(true, false)).toBe(true);
  });
});

describe("InferenceMutex", () => {
  it("orders Moonshine, Nano, and Kokoro work without overlap", async () => {
    const mutex = new InferenceMutex();
    const order: string[] = [];
    let releaseMoonshine!: () => void;
    const moonshineGate = new Promise<void>((resolve) => {
      releaseMoonshine = resolve;
    });

    const moonshine = mutex.run(async () => {
      order.push("moonshine:start");
      await moonshineGate;
      order.push("moonshine:end");
    });
    const nano = mutex.run(async () => {
      order.push("nano");
    });
    const kokoro = mutex.run(async () => {
      order.push("kokoro");
    });

    await vi.waitFor(() =>
      expect(order).toEqual(["moonshine:start"]),
    );
    releaseMoonshine();
    await Promise.all([moonshine, nano, kokoro]);

    expect(order).toEqual([
      "moonshine:start",
      "moonshine:end",
      "nano",
      "kokoro",
    ]);
    expect(mutex.pending).toBe(0);
  });
});
