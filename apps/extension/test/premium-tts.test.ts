import { afterEach, describe, expect, it, vi } from "vitest";

import { InferenceMutex } from "../src/inference-mutex.js";
import {
  PREMIUM_FIRST_AUDIO_TIMEOUT_MS,
  PREMIUM_TTS_PREVIEW_TEXT,
  PremiumTtsRouter,
  premiumEnabledByDefault,
  previewPremiumVoiceSelection,
  splitPremiumSentences,
  type PremiumTtsRequest,
} from "../src/premium-tts.js";

function systemHarness() {
  return {
    playbackState: "idle" as const,
    speak: vi.fn().mockResolvedValue(undefined),
    speakLong: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
    pause: vi.fn(() => true),
    resume: vi.fn(() => true),
    skip: vi.fn(() => true),
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

  it("passes rate and volume to premium and system speech", async () => {
    const system = systemHarness();
    let router!: PremiumTtsRouter;
    const request = vi.fn(async (message: PremiumTtsRequest) => {
      if (message.type !== "premium-speak") return;
      await new Promise<void>((resolve) => {
        queueMicrotask(() => {
          router.notifyFirstAudio(message.utteranceId ?? "");
          resolve();
        });
      });
    });
    router = new PremiumTtsRouter({ system, request });
    router.updateStatus({ state: "ready", enabled: true });

    await router.speak("Premium.", { rate: 1.5, volume: 0.4 });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "premium-speak",
        text: "Premium.",
        rate: 1.5,
        volume: 0.4,
      }),
    );

    router.updateStatus({ state: "ready", enabled: false });
    await router.speak("System.", { rate: 0.7, volume: 0.2 });
    expect(system.speak).toHaveBeenCalledWith(
      "System.",
      { rate: 0.7, volume: 0.2 },
    );
  });

  it("uses a new voice for the next confirmation", async () => {
    const system = systemHarness();
    let router!: PremiumTtsRouter;
    const request = vi.fn(async (message: PremiumTtsRequest) => {
      if (message.type !== "premium-speak") return;
      queueMicrotask(() =>
        router.notifyFirstAudio(message.utteranceId ?? "")
      );
    });
    router = new PremiumTtsRouter({ system, request });
    router.updateStatus({
      state: "ready",
      enabled: true,
      voice: "af_heart",
    });

    router.setVoice("bf_emma");
    await router.speak("This is my voice now.");

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "premium-speak",
        text: "This is my voice now.",
        voice: "bf_emma",
      }),
    );
  });

  it("uses system TTS for every sentence when the ready engine is toggled off", async () => {
    const system = systemHarness();
    const request = vi.fn().mockResolvedValue(undefined);
    const router = new PremiumTtsRouter({ system, request });
    router.updateStatus({ state: "ready", enabled: false });

    await router.speakLong("First. Second.");

    expect(system.speakLong.mock.calls.map(([text]) => text)).toEqual([
      "First.",
      "Second.",
    ]);
    expect(request).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "premium-speak" }),
    );
  });

  it("stops premium before falling back at the 750 ms boundary", async () => {
    vi.useFakeTimers();
    const system = systemHarness();
    const never = new Promise<unknown>(() => undefined);
    let releaseStop!: () => void;
    const stopped = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const request = vi.fn((message: PremiumTtsRequest) => {
      if (message.type === "premium-speak") return never;
      if (message.type === "premium-stop") return stopped;
      return Promise.resolve(undefined);
    });
    const router = new PremiumTtsRouter({ system, request });
    router.updateStatus({ state: "ready", enabled: true });

    const speaking = router.speak("Deadline.");
    await vi.advanceTimersByTimeAsync(PREMIUM_FIRST_AUDIO_TIMEOUT_MS - 1);
    expect(system.speak).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(system.speak).not.toHaveBeenCalled();
    releaseStop();
    await speaking;

    expect(system.speak).toHaveBeenCalledWith("Deadline.", {});
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "premium-stop",
        utteranceId: expect.any(String),
      }),
    );
    expect(router.consecutiveFailures).toBe(1);
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

  it("closes the circuit when a replacement engine becomes ready", async () => {
    const system = systemHarness();
    const request = vi.fn(async (message: PremiumTtsRequest) => {
      if (message.type === "premium-speak") {
        throw new Error("device lost");
      }
    });
    const router = new PremiumTtsRouter({ system, request });
    router.updateStatus({ state: "ready", enabled: true });
    await router.speak("Failure one.");
    await router.speak("Failure two.");
    expect(router.circuitOpen).toBe(true);

    router.updateStatus({ state: "downloading", enabled: true });
    router.updateStatus({ state: "ready", enabled: true });

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
    expect(request).toHaveBeenCalledWith({
      type: "premium-stop",
      utteranceId,
    });
    expect(system.speak).not.toHaveBeenCalled();
  });

  it("targets stale stops so a newer concurrent request is not cancelled", async () => {
    const system = systemHarness();
    const never = new Promise<unknown>(() => undefined);
    const utteranceIds: string[] = [];
    const request = vi.fn((message: PremiumTtsRequest) => {
      if (message.type === "premium-speak") {
        utteranceIds.push(message.utteranceId ?? "");
        return never;
      }
      return Promise.resolve(undefined);
    });
    const router = new PremiumTtsRouter({ system, request });
    router.updateStatus({ state: "ready", enabled: true });

    const first = router.speak("First.");
    await vi.waitFor(() => expect(utteranceIds).toHaveLength(1));
    const second = router.speak("Second.");
    await vi.waitFor(() => expect(utteranceIds).toHaveLength(2));

    expect(request).toHaveBeenCalledWith({
      type: "premium-stop",
      utteranceId: utteranceIds[0],
    });
    expect(request).not.toHaveBeenCalledWith({ type: "premium-stop" });

    router.stop();
    await Promise.all([first, second]);
    expect(request).toHaveBeenCalledWith({
      type: "premium-stop",
      utteranceId: utteranceIds[1],
    });
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

    expect(system.speakLong).toHaveBeenCalledWith(
      "First sentence.",
      expect.objectContaining({ onFirstAudio: expect.any(Function) }),
    );
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

  it("reports the same aggregate boundaries for system and premium speech", async () => {
    const readWith = async (premium: boolean) => {
      const system = systemHarness();
      let router!: PremiumTtsRouter;
      const request = vi.fn(async (message: PremiumTtsRequest) => {
        if (message.type !== "premium-speak") return;
        await new Promise<void>((resolve) => {
          queueMicrotask(() => {
            router.notifyFirstAudio(message.utteranceId ?? "");
            resolve();
          });
        });
      });
      const onProgress = vi.fn();
      router = new PremiumTtsRouter({ system, request });
      router.updateStatus({ state: "ready", enabled: premium });

      await router.speakLong("One. Two.", { onProgress });

      expect(
        system.speakLong.mock.calls.every(
          ([, options]) => options?.onProgress === undefined,
        ),
      ).toBe(true);
      return onProgress.mock.calls.map(([progress]) => progress);
    };

    const systemProgress = await readWith(false);
    const premiumProgress = await readWith(true);
    expect(systemProgress).toEqual(premiumProgress);
    expect(systemProgress).toEqual([
      {
        charIndex: 0,
        totalChars: 9,
        chunkIndex: 0,
        chunkCount: 2,
        chunkCharIndex: 0,
        eventType: "start",
      },
      {
        charIndex: 4,
        totalChars: 9,
        chunkIndex: 0,
        chunkCount: 2,
        chunkCharIndex: 4,
        eventType: "end",
      },
      {
        charIndex: 5,
        totalChars: 9,
        chunkIndex: 1,
        chunkCount: 2,
        chunkCharIndex: 0,
        eventType: "sentence",
      },
      {
        charIndex: 9,
        totalChars: 9,
        chunkIndex: 1,
        chunkCount: 2,
        chunkCharIndex: 4,
        eventType: "end",
      },
    ]);
  });

  it("adopts a newly ready engine during a download transition", async () => {
    const system = systemHarness();
    let router!: PremiumTtsRouter;
    system.speakLong.mockImplementationOnce(async () => {
      router.updateStatus({ state: "ready", enabled: true });
    });
    const request = vi.fn(async (message: PremiumTtsRequest) => {
      if (message.type === "premium-speak") {
        queueMicrotask(() =>
          router.notifyFirstAudio(message.utteranceId ?? "")
        );
      }
    });
    router = new PremiumTtsRouter({ system, request });
    router.updateStatus({ state: "downloading", enabled: true });

    await router.speakLong("System first. Premium second.");

    expect(system.speakLong).toHaveBeenCalledWith(
      "System first.",
      expect.objectContaining({ onFirstAudio: expect.any(Function) }),
    );
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "premium-speak",
        text: "Premium second.",
      }),
    );
  });

  it("delegates system pause, resume, and skip during a long read", async () => {
    const system = systemHarness();
    let finish!: () => void;
    system.speakLong.mockImplementation(
      async () =>
        await new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const router = new PremiumTtsRouter({
      system,
      request: vi.fn().mockResolvedValue(undefined),
    });
    router.updateStatus({ state: "ready", enabled: false });

    const reading = router.speakLong("One sentence.");
    await vi.waitFor(() => expect(system.speakLong).toHaveBeenCalledOnce());
    expect(router.pause()).toBe(true);
    expect(router.playbackState).toBe("paused");
    expect(system.pause).toHaveBeenCalledOnce();
    expect(router.skip()).toBe(true);
    expect(system.skip).toHaveBeenCalledOnce();
    expect(router.resume()).toBe(true);
    expect(system.resume).toHaveBeenCalledOnce();

    finish();
    await reading;
    expect(router.playbackState).toBe("idle");
  });

  it("keeps the premium queue position across pause, skip, and resume", async () => {
    const system = systemHarness();
    const finishes: Array<() => void> = [];
    let router!: PremiumTtsRouter;
    const request = vi.fn((message: PremiumTtsRequest) => {
      if (message.type !== "premium-speak") {
        return Promise.resolve(undefined);
      }
      queueMicrotask(() =>
        router.notifyFirstAudio(message.utteranceId ?? "")
      );
      return new Promise<void>((resolve) => {
        finishes.push(resolve);
      });
    });
    router = new PremiumTtsRouter({ system, request });
    router.updateStatus({ state: "ready", enabled: true });

    const reading = router.speakLong("One. Two. Three.");
    await vi.waitFor(() => expect(finishes).toHaveLength(1));
    expect(router.pause()).toBe(true);
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({ type: "premium-stop" }),
      )
    );
    await vi.waitFor(() => expect(router.playbackState).toBe("paused"));
    expect(router.skip()).toBe(true);
    expect(router.resume()).toBe(true);

    await vi.waitFor(() => expect(finishes).toHaveLength(2));
    finishes[1]?.();
    await reading;

    expect(
      request.mock.calls
        .map(([message]) => message as PremiumTtsRequest)
        .filter((message) => message.type === "premium-speak")
        .map((message) => message.text),
    ).toEqual(["One.", "Three."]);
    expect(system.speak).not.toHaveBeenCalled();
  });

  it("keeps abbreviations and decimals intact and skips punctuation-only input", () => {
    expect(
      splitPremiumSentences(
        "Dr. Smith paid $3.14. Next is the U.S. office.",
      ),
    ).toEqual([
      "Dr. Smith paid $3.14.",
      "Next is the U.S. office.",
    ]);
    expect(splitPremiumSentences(" \n ...?! ")).toEqual([]);

    const longWord = "x".repeat(401);
    const chunks = splitPremiumSentences(longWord);
    expect(chunks.map((chunk) => chunk.length)).toEqual([200, 200, 1]);
    expect(chunks.join("")).toBe(longWord);
  });

  it("reports the existing premium first-audio signal once", async () => {
    const system = systemHarness();
    const firstAudio = vi.fn();
    let router!: PremiumTtsRouter;
    const request = vi.fn(async (message: PremiumTtsRequest) => {
      if (message.type !== "premium-speak") return;
      queueMicrotask(() => {
        router.notifyFirstAudio(message.utteranceId ?? "");
        router.notifyFirstAudio(message.utteranceId ?? "");
      });
    });
    router = new PremiumTtsRouter({ system, request });
    router.updateStatus({ state: "ready", enabled: true });

    await router.speak("Ready.", { onFirstAudio: firstAudio });

    expect(firstAudio).toHaveBeenCalledOnce();
  });

  it("routes a voice preview through the premium speak path", async () => {
    const system = systemHarness();
    let router!: PremiumTtsRouter;
    const request = vi.fn(async (message: PremiumTtsRequest) => {
      if (message.type !== "premium-speak") return;
      await new Promise<void>((resolve) => {
        queueMicrotask(() => {
          router.notifyFirstAudio(message.utteranceId ?? "");
          resolve();
        });
      });
    });
    router = new PremiumTtsRouter({ system, request });
    router.updateStatus({
      state: "ready",
      enabled: false,
      voice: "af_heart",
    });

    await router.preview(
      PREMIUM_TTS_PREVIEW_TEXT,
      "bf_emma",
      { rate: 1.2, volume: 0.6 },
    );

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "premium-speak",
        text: PREMIUM_TTS_PREVIEW_TEXT,
        voice: "bf_emma",
        preview: true,
        rate: 1.2,
        volume: 0.6,
      }),
    );
    expect(system.speak).not.toHaveBeenCalled();
  });
});

describe("premium voice settings", () => {
  it("defaults ON only after a successful download and preserves explicit choice", () => {
    expect(premiumEnabledByDefault(undefined, false)).toBe(false);
    expect(premiumEnabledByDefault(undefined, true)).toBe(true);
    expect(premiumEnabledByDefault(false, true)).toBe(false);
    expect(premiumEnabledByDefault(true, false)).toBe(true);
  });

  it("restores the prior voice when its preview fails", async () => {
    const persist = vi.fn().mockResolvedValue(undefined);
    const speak = vi.fn().mockRejectedValue(
      new Error("Voice download failed"),
    );

    await expect(
      previewPremiumVoiceSelection({
        voice: "bf_emma",
        previousVoice: "af_heart",
        persist,
        speak,
      }),
    ).rejects.toThrow("Voice download failed");

    expect(persist.mock.calls.map(([voice]) => voice)).toEqual([
      "bf_emma",
      "af_heart",
    ]);
    expect(speak).toHaveBeenCalledWith(
      PREMIUM_TTS_PREVIEW_TEXT,
      "bf_emma",
    );
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

  it("continues in FIFO order after a holder throws", async () => {
    const mutex = new InferenceMutex();
    const order: string[] = [];
    const failed = mutex.run(async () => {
      order.push("synthesis");
      throw new Error("ONNX failed");
    });
    const transcription = mutex.run(async () => {
      order.push("transcription");
    });
    const queuedSynthesis = mutex.run(async () => {
      order.push("queued-synthesis");
    });

    await expect(failed).rejects.toThrow("ONNX failed");
    await Promise.all([transcription, queuedSynthesis, mutex.idle()]);

    expect(order).toEqual([
      "synthesis",
      "transcription",
      "queued-synthesis",
    ]);
    expect(mutex.pending).toBe(0);
  });

  it("cancels queued warm-up before prioritized transcription", async () => {
    const mutex = new InferenceMutex();
    const order: string[] = [];
    const controller = new AbortController();
    let releaseActive!: () => void;
    const activeGate = new Promise<void>((resolve) => {
      releaseActive = resolve;
    });

    const active = mutex.run(async () => {
      order.push("active:start");
      await activeGate;
      order.push("active:end");
    });
    const warmup = mutex.run(
      async () => {
        order.push("warmup");
      },
      { priority: "background", signal: controller.signal },
    );
    const transcription = mutex.run(
      async () => {
        order.push("transcription");
      },
      { priority: "transcription" },
    );

    await vi.waitFor(() => expect(order).toEqual(["active:start"]));
    controller.abort();
    releaseActive();

    await expect(warmup).rejects.toMatchObject({ name: "AbortError" });
    await Promise.all([active, transcription, mutex.idle()]);
    expect(order).toEqual([
      "active:start",
      "active:end",
      "transcription",
    ]);
    expect(mutex.pending).toBe(0);
  });
});
