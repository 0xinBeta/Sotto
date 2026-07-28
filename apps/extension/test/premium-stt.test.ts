import { afterEach, describe, expect, it, vi } from "vitest";

import type { SttEngine } from "@sotto/stt";
import { InferenceMutex } from "../src/inference-mutex.js";
import {
  detectPremiumSttTier,
  PremiumSttManager,
  type PremiumSttState,
} from "../src/premium-stt.js";

function engineHarness(
  transcribe: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue("ready"),
) {
  return {
    init: vi.fn().mockImplementation(
      async (
        onProgress?: (progress: {
          readonly status: string;
          readonly progress: number;
        }) => void,
      ) => {
        onProgress?.({ status: "downloading", progress: 0.5 });
        onProgress?.({ status: "validating", progress: 1 });
        onProgress?.({ status: "loading", progress: 1 });
      },
    ),
    transcribe,
    dispose: vi.fn().mockResolvedValue(undefined),
  } satisfies SttEngine;
}

function fixture(): Promise<Float32Array> {
  return Promise.resolve(new Float32Array(6_400).fill(0.05));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("PremiumSttManager", () => {
  it("activates only after ordered validation/warmup and defaults ON", async () => {
    const tiny = engineHarness(vi.fn().mockResolvedValue("tiny"));
    const premium = engineHarness();
    const states: PremiumSttState[] = [];
    const manager = new PremiumSttManager({
      tiny,
      tier: "parakeet",
      createPremium: () => premium,
      runInference: (task) => task(),
      selfTestAudio: fixture,
      onStatus: (status) => states.push(status.state),
    });

    await manager.initializeDefault();
    await manager.prepare();

    expect(states).toEqual(expect.arrayContaining([
      "not-downloaded",
      "downloading",
      "validating",
      "loading",
      "warming",
      "ready",
      "active",
    ]));
    expect(manager.status).toMatchObject({
      state: "active",
      enabled: true,
      downloaded: true,
      resident: true,
      tier: "parakeet",
      backend: "webgpu",
    });
    expect(premium.transcribe).toHaveBeenCalledTimes(1);
    expect(tiny.dispose).toHaveBeenCalledTimes(1);
  });

  it("falls back atomically to tiny when the activation self-test is blank", async () => {
    const tiny = engineHarness(vi.fn().mockResolvedValue("tiny result"));
    const premium = engineHarness(vi.fn().mockResolvedValue(""));
    const diagnostics: string[] = [];
    const manager = new PremiumSttManager({
      tiny,
      tier: "parakeet",
      createPremium: () => premium,
      runInference: (task) => task(),
      selfTestAudio: fixture,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    await manager.initializeDefault();
    await expect(manager.prepare()).rejects.toThrow("self-test");

    expect(manager.status).toMatchObject({
      state: "error",
      downloaded: false,
      resident: false,
    });
    expect(premium.dispose).toHaveBeenCalledTimes(1);
    expect(tiny.dispose).not.toHaveBeenCalled();
    expect(diagnostics).toEqual(["blank-result"]);
    await expect(manager.transcribe(new Float32Array([0.1]))).resolves.toBe(
      "tiny result",
    );
  });

  it("rejects activation above the warm latency threshold and keeps tiny", async () => {
    const tiny = engineHarness();
    const premium = engineHarness();
    const now = vi.fn()
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(1_201);
    const diagnostics: string[] = [];
    const manager = new PremiumSttManager({
      tiny,
      tier: "parakeet",
      createPremium: () => premium,
      runInference: (task) => task(),
      selfTestAudio: fixture,
      now,
      warmupMaxMs: 1_200,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    await manager.initializeDefault();

    await expect(manager.prepare()).rejects.toThrow("latency threshold");
    expect(manager.status.state).toBe("error");
    expect(tiny.dispose).not.toHaveBeenCalled();
    expect(diagnostics).toEqual(["timeout"]);
  });

  it("serializes premium STT inference against a TTS task with the shared mutex", async () => {
    const mutex = new InferenceMutex();
    const tiny = engineHarness();
    let releaseStt!: () => void;
    const sttGate = new Promise<void>((resolve) => {
      releaseStt = resolve;
    });
    const premium = engineHarness(
      vi.fn()
        .mockResolvedValueOnce("ready")
        .mockImplementationOnce(async () => {
          await sttGate;
          return "open calendar";
        }),
    );
    const manager = new PremiumSttManager({
      tiny,
      tier: "parakeet",
      createPremium: () => premium,
      runInference: (task) => mutex.run(task),
      selfTestAudio: fixture,
    });
    await manager.initializeDefault();
    await manager.prepare();

    const order: string[] = [];
    const speech = manager.transcribe(new Float32Array([0.1]))
      .then((text) => order.push(`stt:${text}`));
    await vi.waitFor(() => expect(premium.transcribe).toHaveBeenCalledTimes(2));
    const tts = mutex.run(async () => {
      order.push("tts");
    });
    await Promise.resolve();
    expect(order).toEqual([]);
    releaseStt();
    await Promise.all([speech, tts]);
    expect(order).toEqual(["stt:open calendar", "tts"]);
  });

  it("evicts the LRU peer and retries Parakeet once after device loss", async () => {
    const tiny = engineHarness();
    const first = engineHarness(
      vi.fn()
        .mockResolvedValueOnce("ready")
        .mockRejectedValueOnce(new Error("WebGPU device lost")),
    );
    const replacement = engineHarness(
      vi.fn()
        .mockResolvedValueOnce("ready")
        .mockResolvedValueOnce("recovered"),
    );
    const createPremium = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(replacement);
    const onMemoryPressure = vi.fn().mockResolvedValue(undefined);
    const diagnostics: string[] = [];
    const manager = new PremiumSttManager({
      tiny,
      tier: "parakeet",
      createPremium,
      runInference: (task) => task(),
      selfTestAudio: fixture,
      onMemoryPressure,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    await manager.initializeDefault();
    await manager.prepare();

    await expect(manager.transcribe(new Float32Array([0.1]))).resolves.toBe(
      "recovered",
    );

    expect(onMemoryPressure).toHaveBeenCalledTimes(1);
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(createPremium).toHaveBeenCalledTimes(2);
    expect(diagnostics).toContain("webgpu-failed");
  });

  it("evicts the LRU peer and retries one Parakeet allocation failure while loading", async () => {
    const tiny = engineHarness();
    const first = engineHarness();
    first.init.mockRejectedValueOnce(new Error("WebGPU allocation failed"));
    const replacement = engineHarness();
    const createPremium = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(replacement);
    const onMemoryPressure = vi.fn().mockResolvedValue(undefined);
    const manager = new PremiumSttManager({
      tiny,
      tier: "parakeet",
      createPremium,
      runInference: (task) => task(),
      selfTestAudio: fixture,
      onMemoryPressure,
    });
    await manager.initializeDefault();

    await expect(manager.prepare()).resolves.toBeUndefined();

    expect(onMemoryPressure).toHaveBeenCalledTimes(1);
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(createPremium).toHaveBeenCalledTimes(2);
    expect(manager.status).toMatchObject({
      state: "active",
      resident: true,
    });
  });

  it("uses tiny after a cached premium reload fails instead of dropping speech", async () => {
    const tiny = engineHarness(vi.fn().mockResolvedValue("tiny result"));
    const premium = engineHarness();
    premium.init.mockRejectedValue(new Error("cached model could not load"));
    const manager = new PremiumSttManager({
      tiny,
      tier: "parakeet",
      downloaded: true,
      storedEnabled: true,
      createPremium: () => premium,
      runInference: (task) => task(),
      selfTestAudio: fixture,
    });

    await manager.initializeDefault();

    expect(manager.status.state).toBe("error");
    await expect(manager.transcribe(new Float32Array([0.1]))).resolves.toBe(
      "tiny result",
    );
    expect(premium.init).toHaveBeenCalledTimes(1);
  });

  it("selects Parakeet only after a successful adapter request", async () => {
    vi.stubGlobal("navigator", {
      gpu: {
        requestAdapter: vi.fn().mockResolvedValue({}),
      },
    });
    await expect(detectPremiumSttTier()).resolves.toBe("parakeet");

    vi.stubGlobal("navigator", {
      gpu: {
        requestAdapter: vi.fn().mockResolvedValue(null),
      },
    });
    await expect(detectPremiumSttTier()).resolves.toBe("moonshine-base");

    vi.stubGlobal("navigator", {});
    await expect(detectPremiumSttTier()).resolves.toBe("moonshine-base");
  });

  it("uses the Moonshine base WASM tier supplied on no-WebGPU hardware", async () => {
    const tiny = engineHarness();
    const base = engineHarness();
    const createPremium = vi.fn().mockReturnValue(base);
    const manager = new PremiumSttManager({
      tiny,
      tier: "moonshine-base",
      createPremium,
      runInference: (task) => task(),
      selfTestAudio: fixture,
    });

    await manager.initializeDefault();
    await manager.prepare();

    expect(createPremium).toHaveBeenCalledWith("moonshine-base");
    expect(manager.status).toMatchObject({
      tier: "moonshine-base",
      backend: "wasm",
      state: "active",
    });
  });
});
