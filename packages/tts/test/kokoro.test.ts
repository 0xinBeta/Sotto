import { afterEach, describe, expect, it, vi } from "vitest";
import { KokoroTTS } from "kokoro-js";

import {
  KOKORO_MODEL_ID,
  KOKORO_MODEL_REVISION,
  KOKORO_SAMPLE_RATE,
  KOKORO_VOICE,
  KokoroTtsEngine,
  MAX_KOKORO_CHUNK_CHARACTERS,
  selectKokoroBackend,
  splitTextForKokoro,
  type KokoroRuntime,
} from "../src/kokoro.js";

class FakeSplitter {
  #text = "";

  push(...text: string[]): void {
    this.#text += text.join("");
  }

  close(): void {}

  [Symbol.iterator](): Iterator<string> {
    const sentences =
      this.#text.match(/[^.!?]+[.!?]+|[^.!?]+$/g)?.map((part) => part.trim()) ??
        [];
    return sentences[Symbol.iterator]();
  }
}

class FakeSource {
  buffer: AudioBuffer | null = null;
  onended: (() => void) | null = null;
  readonly connect = vi.fn(() => this);
  readonly start = vi.fn();
  readonly stop = vi.fn(() => this.finish());

  finish(): void {
    const ended = this.onended;
    this.onended = null;
    ended?.();
  }
}

class FakeAudioContext {
  currentTime = 0;
  state: AudioContextState = "running";
  readonly destination = {} as AudioDestinationNode;
  readonly sources: FakeSource[] = [];
  readonly close = vi.fn(async () => {
    this.state = "closed";
  });
  readonly resume = vi.fn(async () => {
    this.state = "running";
  });

  createBuffer(
    _channels: number,
    length: number,
    sampleRate: number,
  ): AudioBuffer {
    const channel = new Float32Array(length);
    return {
      duration: length / sampleRate,
      getChannelData: () => channel,
    } as unknown as AudioBuffer;
  }

  createBufferSource(): AudioBufferSourceNode {
    const source = new FakeSource();
    this.sources.push(source);
    return source as unknown as AudioBufferSourceNode;
  }

  createGain(): GainNode {
    return {
      gain: { value: 1 },
      connect: vi.fn(function (this: GainNode) {
        return this;
      }),
    } as unknown as GainNode;
  }
}

function audio(): {
  readonly data: Float32Array;
  readonly sampling_rate: number;
} {
  return {
    data: new Float32Array(KOKORO_SAMPLE_RATE / 100),
    sampling_rate: KOKORO_SAMPLE_RATE,
  };
}

function runtimeHarness(options: {
  readonly failWebGpu?: boolean;
  readonly onGenerate?: (text: string) => Promise<void> | void;
} = {}) {
  const dispose = vi.fn();
  let concurrent = 0;
  let maximumConcurrent = 0;
  const generate = vi.fn(async (text: string) => {
    concurrent += 1;
    maximumConcurrent = Math.max(maximumConcurrent, concurrent);
    try {
      await options.onGenerate?.(text);
      return audio();
    } finally {
      concurrent -= 1;
    }
  });
  const load = vi.fn(async (request: {
    readonly device: "webgpu" | "wasm";
  }) => {
    if (options.failWebGpu && request.device === "webgpu") {
      throw new Error("WebGPU session creation failed");
    }
    return {
      model: { dispose },
      generate,
    };
  });
  const setWasmPaths = vi.fn();
  const runtime: KokoroRuntime = {
    load: load as KokoroRuntime["load"],
    createSplitter: () => new FakeSplitter(),
    setWasmPaths,
  };
  return {
    dispose,
    generate,
    load,
    runtime,
    setWasmPaths,
    maximumConcurrent: () => maximumConcurrent,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("KokoroTtsEngine", () => {
  it("rejects any model revision other than the reviewed pin", () => {
    expect(() =>
      KokoroTTS.from_pretrained(KOKORO_MODEL_ID, {
        revision: "main",
      })
    ).toThrow(`Kokoro revision must be pinned to ${KOKORO_MODEL_REVISION}`);
  });

  it("hard-caps TextSplitterStream sentences without breaking UTF-16", () => {
    const chunks = splitTextForKokoro(
      `A short sentence. ${"word ".repeat(90)}🙂`,
      () => new FakeSplitter(),
    );

    expect(chunks.length).toBeGreaterThan(2);
    expect(
      chunks.every((chunk) => chunk.length <= MAX_KOKORO_CHUNK_CHARACTERS),
    ).toBe(true);
    expect(chunks.join(" ")).toContain("🙂");
  });

  it.each([
    [true, "webgpu", "fp32"],
    [false, "wasm", "q8"],
  ] as const)(
    "selects the approved backend and dtype when WebGPU availability is %s",
    async (available, backend, dtype) => {
      await expect(
        selectKokoroBackend(async () => available),
      ).resolves.toEqual({ backend, dtype });
    },
  );

  it("pins model/revision/voice, prewarms, and falls back to q8 WASM", async () => {
    const harness = runtimeHarness({ failWebGpu: true });
    const context = new FakeAudioContext();
    const engine = new KokoroTtsEngine({
      runtime: harness.runtime,
      audioContextFactory: () => context as unknown as AudioContext,
      runtimeUrl: (path) => `chrome-extension://sotto/${path}`,
      webGpuAvailable: async () => true,
    });

    await engine.init();

    expect(harness.load).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        modelId: KOKORO_MODEL_ID,
        revision: KOKORO_MODEL_REVISION,
        device: "webgpu",
        dtype: "fp32",
      }),
    );
    expect(harness.load).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        device: "wasm",
        dtype: "q8",
      }),
    );
    expect(harness.generate).toHaveBeenCalledWith("Ready.", {
      voice: KOKORO_VOICE,
      speed: 1,
    });
    expect(engine.backend).toBe("wasm");
    expect(engine.dtype).toBe("q8");
    expect(harness.setWasmPaths).toHaveBeenCalledWith(
      "chrome-extension://sotto/assets/ort-kokoro/",
    );
  });

  it("serializes synthesis, limits lookahead to three, and drops played sources", async () => {
    const harness = runtimeHarness();
    const context = new FakeAudioContext();
    const engine = new KokoroTtsEngine({
      runtime: harness.runtime,
      audioContextFactory: () => context as unknown as AudioContext,
      runtimeUrl: (path) => path,
      backend: "wasm",
    });
    await engine.init();
    harness.generate.mockClear();

    const firstAudio = vi.fn();
    const progress = vi.fn();
    const speaking = engine.speakLong(
      "One. Two. Three. Four.",
      { onFirstAudio: firstAudio, onProgress: progress },
    );

    await vi.waitFor(() => expect(context.sources).toHaveLength(3));
    expect(harness.generate).toHaveBeenCalledTimes(3);
    expect(firstAudio).toHaveBeenCalledOnce();
    expect(harness.maximumConcurrent()).toBe(1);

    context.sources[0]?.finish();
    await vi.waitFor(() => expect(context.sources).toHaveLength(4));
    expect(harness.generate).toHaveBeenCalledTimes(4);

    for (const source of context.sources) source.finish();
    await expect(speaking).resolves.toBeUndefined();
    expect(progress.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({
        charIndex: "One. Two. Three. Four.".length,
        eventType: "end",
      }),
    );
  });

  it("stops scheduled audio immediately and disposes without deleting cache", async () => {
    const harness = runtimeHarness();
    const context = new FakeAudioContext();
    const engine = new KokoroTtsEngine({
      runtime: harness.runtime,
      audioContextFactory: () => context as unknown as AudioContext,
      runtimeUrl: (path) => path,
      backend: "wasm",
    });
    await engine.init();

    const speaking = engine.speak("Stop me.");
    await vi.waitFor(() => expect(context.sources).toHaveLength(1));
    engine.stop();

    await expect(speaking).resolves.toBeUndefined();
    expect(context.sources[0]?.stop).toHaveBeenCalledOnce();
    await engine.dispose();
    expect(harness.dispose).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
  });
});
