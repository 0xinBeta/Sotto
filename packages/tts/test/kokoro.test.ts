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
  state: AudioContextState;
  readonly destination = {} as AudioDestinationNode;
  readonly sources: FakeSource[] = [];
  readonly #resumeSucceeds: boolean;
  readonly close = vi.fn(async () => {
    this.state = "closed";
  });
  readonly resume = vi.fn(async () => {
    if (this.#resumeSucceeds) this.state = "running";
  });

  constructor(
    state: AudioContextState = "running",
    resumeSucceeds = true,
  ) {
    this.state = state;
    this.#resumeSucceeds = resumeSucceeds;
  }

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
  vi.unstubAllGlobals();
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

  it("pins model and voice fetches without altering other requests", async () => {
    const upstreamClass = Object.getPrototypeOf(KokoroTTS) as {
      from_pretrained: ReturnType<typeof vi.fn>;
    };
    vi.spyOn(upstreamClass, "from_pretrained").mockResolvedValue({});
    const upstreamFetch = vi.fn().mockResolvedValue(new Response());
    vi.stubGlobal("fetch", upstreamFetch);

    await KokoroTTS.from_pretrained(KOKORO_MODEL_ID, {
      revision: KOKORO_MODEL_REVISION,
    });
    const installedFetch = globalThis.fetch;
    await KokoroTTS.from_pretrained(KOKORO_MODEL_ID, {
      revision: KOKORO_MODEL_REVISION,
    });
    expect(globalThis.fetch).toBe(installedFetch);

    const otherInit = { headers: { "x-sotto": "untouched" } };
    await installedFetch("https://example.com/model.bin", otherInit);
    expect(upstreamFetch).toHaveBeenNthCalledWith(
      1,
      "https://example.com/model.bin",
      otherInit,
    );

    const voiceRequest = new Request(
      `https://huggingface.co/${KOKORO_MODEL_ID}/resolve/main/voices/${KOKORO_VOICE}.bin`,
      {
        method: "POST",
        headers: { "x-sotto": "preserved" },
        body: "voice-body",
      },
    );
    await installedFetch(voiceRequest);
    const pinnedRequest = upstreamFetch.mock.calls[1]?.[0] as Request;
    expect(pinnedRequest).toBeInstanceOf(Request);
    expect(pinnedRequest.url).toContain(
      `/resolve/${KOKORO_MODEL_REVISION}/voices/${KOKORO_VOICE}.bin`,
    );
    expect(pinnedRequest.method).toBe("POST");
    expect(pinnedRequest.headers.get("x-sotto")).toBe("preserved");
    await expect(pinnedRequest.text()).resolves.toBe("voice-body");
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

  it("keeps abbreviations and numbers in the splitter and drops non-speech", () => {
    expect(
      splitTextForKokoro("Dr. Smith paid $3.14. Next sentence."),
    ).toEqual([
      "Dr. Smith paid $3.14.",
      "Next sentence.",
    ]);
    expect(splitTextForKokoro(" \n ...?! ")).toEqual([]);

    const longWord = "x".repeat(MAX_KOKORO_CHUNK_CHARACTERS * 2 + 1);
    const chunks = splitTextForKokoro(longWord);
    expect(chunks.map((chunk) => chunk.length)).toEqual([
      MAX_KOKORO_CHUNK_CHARACTERS,
      MAX_KOKORO_CHUNK_CHARACTERS,
      1,
    ]);
    expect(chunks.join("")).toBe(longWord);
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
    expect(context.sources[0]?.buffer).toBeNull();

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

  it("returns immediately on barge-in while ONNX stays serialized", async () => {
    let releaseInference!: () => void;
    const inferenceGate = new Promise<void>((resolve) => {
      releaseInference = resolve;
    });
    const harness = runtimeHarness({
      onGenerate: async (text) => {
        if (text === "First.") await inferenceGate;
      },
    });
    const context = new FakeAudioContext();
    const engine = new KokoroTtsEngine({
      runtime: harness.runtime,
      audioContextFactory: () => context as unknown as AudioContext,
      runtimeUrl: (path) => path,
      backend: "wasm",
    });
    await engine.init();
    harness.generate.mockClear();

    const first = engine.speak("First.");
    await vi.waitFor(() =>
      expect(harness.generate).toHaveBeenCalledWith("First.", {
        voice: KOKORO_VOICE,
        speed: 1,
      }),
    );
    const second = engine.speakLong("Second.");
    await expect(first).resolves.toBeUndefined();
    expect(harness.generate).toHaveBeenCalledTimes(1);
    expect(context.sources).toHaveLength(0);

    releaseInference();
    await vi.waitFor(() => expect(context.sources).toHaveLength(1));
    expect(harness.maximumConcurrent()).toBe(1);
    context.sources[0]?.finish();
    await expect(second).resolves.toBeUndefined();
  });

  it("resumes a suspended AudioContext before playback", async () => {
    const harness = runtimeHarness();
    const context = new FakeAudioContext("suspended");
    const engine = new KokoroTtsEngine({
      runtime: harness.runtime,
      audioContextFactory: () => context as unknown as AudioContext,
      runtimeUrl: (path) => path,
      backend: "wasm",
    });
    await engine.init();

    const speaking = engine.speak("Resume.");
    await vi.waitFor(() => expect(context.sources).toHaveLength(1));
    expect(context.resume).toHaveBeenCalledOnce();
    context.sources[0]?.finish();
    await expect(speaking).resolves.toBeUndefined();
  });

  it("does not orphan a source when stopped while playback is resuming", async () => {
    let finishResume!: () => void;
    const resumeGate = new Promise<void>((resolve) => {
      finishResume = resolve;
    });
    const harness = runtimeHarness();
    const context = new FakeAudioContext("suspended");
    context.resume.mockImplementation(async () => {
      await resumeGate;
      context.state = "running";
    });
    const engine = new KokoroTtsEngine({
      runtime: harness.runtime,
      audioContextFactory: () => context as unknown as AudioContext,
      runtimeUrl: (path) => path,
      backend: "wasm",
    });
    await engine.init();

    const speaking = engine.speak("Do not orphan.");
    await vi.waitFor(() => expect(context.resume).toHaveBeenCalledOnce());
    engine.stop();
    finishResume();

    await expect(speaking).resolves.toBeUndefined();
    expect(context.sources).toHaveLength(0);
  });

  it("fails instead of reporting first audio while playback remains suspended", async () => {
    const harness = runtimeHarness();
    const context = new FakeAudioContext("suspended", false);
    const engine = new KokoroTtsEngine({
      runtime: harness.runtime,
      audioContextFactory: () => context as unknown as AudioContext,
      runtimeUrl: (path) => path,
      backend: "wasm",
    });
    await engine.init();
    const firstAudio = vi.fn();

    await expect(
      engine.speak("Blocked.", { onFirstAudio: firstAudio }),
    ).rejects.toThrow("Kokoro audio context is suspended");
    expect(firstAudio).not.toHaveBeenCalled();
    expect(context.sources).toHaveLength(0);
  });
});
