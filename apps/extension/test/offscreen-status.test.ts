import { afterEach, describe, expect, it, vi } from "vitest";

const nano = vi.hoisted(() => ({
  askPageWithPrompt: vi.fn(),
  getNanoAvailability: vi.fn(),
  parseCommand: vi.fn(),
  respondOneSentence: vi.fn(),
  rewriteWithPrompt: vi.fn(),
  summarizeWithPrompt: vi.fn(),
}));
const premium = vi.hoisted(() => ({
  init: vi.fn(),
  speak: vi.fn(),
  stop: vi.fn(),
  probe: vi.fn(),
  dispose: vi.fn(),
}));
const speech = vi.hoisted(() => ({
  moonshineOptions: [] as unknown[],
  moonshineInit: vi.fn(),
  moonshineTranscribe: vi.fn(),
  moonshineDispose: vi.fn(),
  parakeetOptions: [] as unknown[],
  parakeetInit: vi.fn(),
  parakeetTranscribe: vi.fn(),
  parakeetDispose: vi.fn(),
}));
const vad = vi.hoisted(() => ({
  create: vi.fn(),
}));

vi.mock("@ricky0123/vad-web", () => ({
  MicVAD: { new: vad.create },
}));
vi.mock("@sotto/actions", () => ({ default: [] }));
vi.mock("@sotto/core", () => ({
  ActionRegistry: class ActionRegistry {},
}));
vi.mock("@sotto/nano", () => ({
  askPageWithPrompt: nano.askPageWithPrompt,
  createParserSession: vi.fn(),
  createResponderSession: vi.fn(),
  getNanoAvailability: nano.getNanoAvailability,
  parseCommand: nano.parseCommand,
  respondOneSentence: nano.respondOneSentence,
  rewriteWithPrompt: nano.rewriteWithPrompt,
  summarizeWithPrompt: nano.summarizeWithPrompt,
}));
vi.mock("@sotto/stt", () => ({
  MoonshineEngine: class MoonshineEngine {
    constructor(options?: unknown) {
      speech.moonshineOptions.push(options);
    }
    init = speech.moonshineInit;
    transcribe = speech.moonshineTranscribe;
    dispose = speech.moonshineDispose;
  },
  ParakeetSttEngine: class ParakeetSttEngine {
    constructor(options?: unknown) {
      speech.parakeetOptions.push(options);
    }
    init = speech.parakeetInit;
    transcribe = speech.parakeetTranscribe;
    dispose = speech.parakeetDispose;
  },
}));
vi.mock("@sotto/tts/kokoro", () => ({
  KokoroTtsEngine: class KokoroTtsEngine {
    backend = "webgpu" as const;
    init = premium.init;
    speak = premium.speak;
    stop = premium.stop;
    probe = premium.probe;
    dispose = premium.dispose;
  },
}));

type OffscreenListener = (
  message: unknown,
  sender: unknown,
  respond: (response: unknown) => void,
) => boolean | void;

async function installPremiumOffscreen(options: {
  readonly initialStorage?: Record<string, unknown>;
  readonly storageGetError?: Error;
  readonly webGpu?: boolean;
} = {}) {
  nano.getNanoAvailability.mockResolvedValue("unavailable");
  premium.init.mockResolvedValue(undefined);
  premium.dispose.mockResolvedValue(undefined);
  speech.moonshineInit.mockResolvedValue(undefined);
  speech.moonshineTranscribe.mockResolvedValue("ready");
  speech.moonshineDispose.mockResolvedValue(undefined);
  speech.parakeetInit.mockResolvedValue(undefined);
  speech.parakeetTranscribe.mockResolvedValue("ready");
  speech.parakeetDispose.mockResolvedValue(undefined);
  vad.create.mockResolvedValue({
    start: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
  });
  const values = { ...options.initialStorage };
  const sendMessage = vi.fn().mockImplementation(
    async (message: { readonly target?: string }) =>
      message.target === "worker" ? { ok: true } : undefined,
  );
  let onMessage: OffscreenListener | undefined;
  vi.stubGlobal("navigator", {
    ...(options.webGpu
      ? {
          gpu: {
            requestAdapter: vi.fn().mockResolvedValue({}),
          },
        }
      : {}),
    permissions: {
      query: vi.fn().mockResolvedValue({ state: "granted" }),
    },
    mediaDevices: {
      getUserMedia: vi.fn().mockResolvedValue({
        getTracks: () => [{ stop: vi.fn() }],
      }),
    },
  });
  vi.stubGlobal("window", {
    addEventListener: vi.fn(),
    clearInterval,
    clearTimeout,
    setInterval,
    setTimeout,
  });
  vi.stubGlobal("chrome", {
    runtime: {
      getURL: vi.fn((path: string) => `chrome-extension://sotto/${path}`),
      sendMessage,
      onMessage: {
        addListener: vi.fn((listener) => {
          onMessage = listener;
        }),
      },
    },
    storage: {
      local: {
        get: vi.fn(async (keys: string | readonly string[]) => {
          if (options.storageGetError) throw options.storageGetError;
          const selected = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(
            selected
              .filter((key) => key in values)
              .map((key) => [key, values[key]]),
          );
        }),
        set: vi.fn(async (updates: Record<string, unknown>) => {
          Object.assign(values, updates);
        }),
      },
    },
  });

  await import("../src/offscreen.js");
  if (!onMessage) throw new Error("Offscreen message listener was not installed");
  return {
    sendMessage,
    values,
    message: (message: Record<string, unknown>) =>
      new Promise<unknown>((resolve) => {
        expect(
          onMessage?.({ target: "offscreen", ...message }, {}, resolve),
        ).toBe(true);
      }),
  };
}

afterEach(() => {
  vi.useRealTimers();
  nano.askPageWithPrompt.mockReset();
  nano.parseCommand.mockReset();
  vi.resetModules();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  nano.rewriteWithPrompt.mockReset();
  nano.summarizeWithPrompt.mockReset();
  premium.init.mockReset();
  premium.speak.mockReset();
  premium.stop.mockReset();
  premium.probe.mockReset();
  premium.dispose.mockReset();
  speech.moonshineOptions.splice(0);
  speech.moonshineInit.mockReset();
  speech.moonshineTranscribe.mockReset();
  speech.moonshineDispose.mockReset();
  speech.parakeetInit.mockReset();
  speech.parakeetOptions.splice(0);
  speech.parakeetTranscribe.mockReset();
  speech.parakeetDispose.mockReset();
  vad.create.mockReset();
});

describe("offscreen fail-soft status", () => {
  it("downloads premium voice, persists default ON, and publishes progress", async () => {
    nano.getNanoAvailability.mockResolvedValue("unavailable");
    premium.init.mockImplementation(
      async (
        onProgress: (progress: {
          readonly status: string;
          readonly progress: number;
          readonly file?: string;
        }) => void,
      ) => {
        onProgress({
          status: "progress",
          progress: 0.5,
          file: "onnx/model.onnx",
        });
      },
    );
    premium.dispose.mockResolvedValue(undefined);
    const values: Record<string, unknown> = {};
    const storageSet = vi.fn(async (updates: Record<string, unknown>) => {
      Object.assign(values, updates);
    });
    const sendMessage = vi.fn().mockImplementation(
      async (message: { readonly target?: string }) =>
        message.target === "worker" ? { ok: true } : undefined,
    );
    let onMessage:
      | ((
          message: unknown,
          sender: unknown,
          respond: (response: unknown) => void,
        ) => boolean | void)
      | undefined;
    vi.stubGlobal("navigator", {
      permissions: {
        query: vi.fn().mockResolvedValue({ state: "granted" }),
      },
    });
    vi.stubGlobal("window", { addEventListener: vi.fn() });
    vi.stubGlobal("chrome", {
      runtime: {
        getURL: vi.fn((path: string) => `chrome-extension://sotto/${path}`),
        sendMessage,
        onMessage: {
          addListener: vi.fn((listener) => {
            onMessage = listener;
          }),
        },
      },
      storage: {
        local: {
          get: vi.fn(async (keys: string | readonly string[]) => {
            const selected = Array.isArray(keys) ? keys : [keys];
            return Object.fromEntries(
              selected
                .filter((key) => key in values)
                .map((key) => [key, values[key]]),
            );
          }),
          set: storageSet,
        },
      },
    });

    await import("../src/offscreen.js");
    if (!onMessage) throw new Error("Offscreen message listener was not installed");
    const response = new Promise<unknown>((resolve) => {
      onMessage?.(
        { target: "offscreen", type: "prepare-premium-tts" },
        {},
        resolve,
      );
    });

    await expect(response).resolves.toEqual({ ok: true });
    expect(values).toMatchObject({
      premiumTtsDownloaded: true,
      premiumTtsEnabled: true,
    });
    expect(sendMessage).toHaveBeenCalledWith({
      target: "sidepanel",
      type: "model-progress",
      model: "premium-tts",
      progress: 0.5,
      status: "progress",
      file: "onnx/model.onnx",
    });
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        target: "sidepanel",
        type: "premium-tts-state",
        state: "ready",
        enabled: true,
        backend: "webgpu",
      }),
    );
  });

  it("selects and persists Parakeet on WebGPU, publishes progress, and defaults ON after warmup", async () => {
    const harness = await installPremiumOffscreen({ webGpu: true });
    speech.parakeetInit.mockImplementation(
      async (
        onProgress?: (progress: {
          readonly status: string;
          readonly progress: number;
          readonly file?: string;
        }) => void,
      ) => {
        onProgress?.({
          status: "downloading",
          progress: 0.5,
          file: "encoder-model.int4.onnx",
        });
      },
    );

    await expect(
      harness.message({ type: "prepare-premium-stt" }),
    ).resolves.toEqual({ ok: true });

    expect(speech.parakeetOptions).toHaveLength(1);
    expect(harness.values).toMatchObject({
      premiumSttDownloaded: true,
      premiumSttDownloadedTiers: { parakeet: true },
      premiumSttEnabled: true,
      premiumSttTier: "parakeet",
    });
    expect(harness.sendMessage).toHaveBeenCalledWith({
      target: "sidepanel",
      type: "model-progress",
      model: "premium-stt",
      progress: 0.5,
      status: "downloading",
      file: "encoder-model.int4.onnx",
    });
    expect(harness.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        target: "sidepanel",
        type: "premium-stt-state",
        state: "active",
        enabled: true,
        downloaded: true,
        tier: "parakeet",
        backend: "webgpu",
      }),
    );
  });

  it("offers Moonshine base q8 WASM when WebGPU is unavailable", async () => {
    const harness = await installPremiumOffscreen();

    await expect(
      harness.message({ type: "prepare-premium-stt" }),
    ).resolves.toEqual({ ok: true });

    expect(speech.moonshineOptions).toContainEqual({
      model: "base",
      backend: "wasm",
    });
    expect(harness.values).toMatchObject({
      premiumSttDownloaded: true,
      premiumSttDownloadedTiers: { "moonshine-base": true },
      premiumSttEnabled: true,
      premiumSttTier: "moonshine-base",
    });
    expect(harness.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        target: "sidepanel",
        type: "premium-stt-state",
        state: "active",
        tier: "moonshine-base",
        backend: "wasm",
      }),
    );
  });

  it("does not activate a persisted Parakeet tier after WebGPU is lost", async () => {
    const harness = await installPremiumOffscreen({
      initialStorage: {
        premiumSttDownloaded: true,
        premiumSttDownloadedTiers: { parakeet: true },
        premiumSttEnabled: true,
        premiumSttTier: "parakeet",
      },
    });

    await expect(
      harness.message({ type: "start-listening" }),
    ).resolves.toEqual({ ok: true });

    expect(speech.parakeetInit).not.toHaveBeenCalled();
    expect(speech.moonshineOptions).not.toContainEqual({
      model: "base",
      backend: "wasm",
    });
    expect(harness.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        target: "sidepanel",
        type: "premium-stt-state",
        tier: "moonshine-base",
        downloaded: false,
      }),
    );
  });

  it("remembers cached Parakeet independently when WebGPU returns", async () => {
    const harness = await installPremiumOffscreen({
      webGpu: true,
      initialStorage: {
        premiumSttDownloaded: true,
        premiumSttDownloadedTiers: {
          parakeet: true,
          "moonshine-base": true,
        },
        premiumSttEnabled: true,
        premiumSttTier: "moonshine-base",
      },
    });

    await expect(
      harness.message({ type: "start-listening" }),
    ).resolves.toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(speech.parakeetInit).toHaveBeenCalledTimes(1)
    );

    expect(speech.parakeetOptions).toHaveLength(1);
    expect(harness.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        target: "sidepanel",
        type: "premium-stt-state",
        tier: "parakeet",
      }),
    );
  });

  it("hands STT explicit 256 ms pre-roll, 192 ms post-roll, and 320 ms voiced gating", async () => {
    const harness = await installPremiumOffscreen();

    await expect(
      harness.message({ type: "start-listening" }),
    ).resolves.toEqual({ ok: true });

    expect(vad.create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "v5",
        positiveSpeechThreshold: 0.3,
        negativeSpeechThreshold: 0.25,
        preSpeechPadMs: 256,
        redemptionMs: 192,
        minSpeechMs: 320,
      }),
    );
  });

  it("publishes smoothed levels until stop and reports a very low meter", async () => {
    vi.useFakeTimers();
    const source = {
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    const analyser = {
      fftSize: 32,
      smoothingTimeConstant: 1,
      disconnect: vi.fn(),
      getFloatTimeDomainData: vi.fn((samples: Float32Array) => {
        samples.fill(0.01);
      }),
    };
    const close = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal(
      "AudioContext",
      class FakeAudioContext {
        createAnalyser() {
          return analyser;
        }

        createMediaStreamSource() {
          return source;
        }

        resume() {
          return Promise.resolve();
        }

        close() {
          return close();
        }
      },
    );
    const harness = await installPremiumOffscreen();

    await expect(
      harness.message({ type: "start-listening" }),
    ).resolves.toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(67);

    const meterMessages = harness.sendMessage.mock.calls
      .map(([message]) => message)
      .filter((message) => message.type === "mic-level");
    expect(meterMessages).toHaveLength(1);
    expect(meterMessages[0]).toMatchObject({
      target: "sidepanel",
      type: "mic-level",
    });
    expect(meterMessages[0]?.level).toBeCloseTo(0.0065);

    const vadOptions = vad.create.mock.calls[0]?.[0] as {
      onVADMisfire(): void;
    };
    vadOptions.onVADMisfire();
    await Promise.resolve();
    expect(harness.sendMessage).toHaveBeenCalledWith({
      target: "sidepanel",
      type: "stt-diagnostic",
      diagnostic: "vad-rejected",
      message: "The microphone level was very low.",
    });

    await expect(
      harness.message({ type: "stop-listening" }),
    ).resolves.toEqual({ ok: true });
    const countAfterStop = harness.sendMessage.mock.calls
      .map(([message]) => message)
      .filter((message) => message.type === "mic-level").length;
    await vi.advanceTimersByTimeAsync(500);
    expect(
      harness.sendMessage.mock.calls
        .map(([message]) => message)
        .filter((message) => message.type === "mic-level"),
    ).toHaveLength(countAfterStop);

    await vi.advanceTimersByTimeAsync(150);
    expect(close).toHaveBeenCalledOnce();
  });

  it("uses safe system-TTS defaults when settings storage cannot be read", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const harness = await installPremiumOffscreen({
      storageGetError: new Error("storage unavailable"),
    });

    await expect(harness.message({ type: "get-status" })).resolves.toEqual({
      ok: true,
    });
    expect(premium.init).not.toHaveBeenCalled();
    expect(harness.sendMessage).toHaveBeenCalledWith({
      target: "sidepanel",
      type: "premium-tts-state",
      state: "absent",
      enabled: false,
    });
  });

  it("does not cut the current sentence when premium is toggled off", async () => {
    let finishSpeech!: () => void;
    premium.speak.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishSpeech = resolve;
        }),
    );
    const harness = await installPremiumOffscreen();
    await expect(
      harness.message({ type: "prepare-premium-tts" }),
    ).resolves.toEqual({ ok: true });

    const speaking = harness.message({
      type: "premium-speak",
      utteranceId: "toggle-current",
      text: "Finish this sentence.",
    });
    await vi.waitFor(() => expect(premium.speak).toHaveBeenCalledOnce());
    await expect(
      harness.message({
        type: "set-premium-tts-enabled",
        enabled: false,
      }),
    ).resolves.toEqual({ ok: true });

    expect(premium.stop).not.toHaveBeenCalled();
    finishSpeech();
    await expect(speaking).resolves.toEqual({ ok: true });
    expect(harness.values.premiumTtsEnabled).toBe(false);
  });

  it("ignores a stale targeted stop after a newer utterance starts", async () => {
    const resolvers: Array<() => void> = [];
    premium.speak.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const harness = await installPremiumOffscreen();
    await harness.message({ type: "prepare-premium-tts" });

    const first = harness.message({
      type: "premium-speak",
      utteranceId: "older",
      text: "Older.",
    });
    await vi.waitFor(() => expect(resolvers).toHaveLength(1));
    const second = harness.message({
      type: "premium-speak",
      utteranceId: "newer",
      text: "Newer.",
    });
    await vi.waitFor(() => expect(resolvers).toHaveLength(2));

    await expect(
      harness.message({ type: "premium-stop", utteranceId: "older" }),
    ).resolves.toEqual({ ok: true });
    expect(premium.stop).not.toHaveBeenCalled();
    await expect(
      harness.message({ type: "premium-stop", utteranceId: "newer" }),
    ).resolves.toEqual({ ok: true });
    expect(premium.stop).toHaveBeenCalledOnce();

    for (const resolve of resolvers) resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { ok: true },
      { ok: true },
    ]);
  });

  it("reports Nano as unavailable through the pipeline message boundary", async () => {
    nano.getNanoAvailability.mockReset();
    nano.getNanoAvailability.mockResolvedValue("unavailable");
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    let onMessage:
      | ((
          message: unknown,
          sender: unknown,
          respond: (response: unknown) => void,
        ) => boolean | void)
      | undefined;

    vi.stubGlobal("navigator", {
      permissions: {
        query: vi.fn().mockResolvedValue({ state: "denied" }),
      },
    });
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
    });
    vi.stubGlobal("chrome", {
      runtime: {
        getURL: vi.fn((path: string) => `chrome-extension://sotto/${path}`),
        sendMessage,
        onMessage: {
          addListener: vi.fn((listener) => {
            onMessage = listener;
          }),
        },
      },
    });

    await import("../src/offscreen.js");
    if (!onMessage) throw new Error("Offscreen message listener was not installed");

    const response = new Promise<unknown>((resolve) => {
      expect(
        onMessage?.(
          { target: "offscreen", type: "get-status" },
          {},
          resolve,
        ),
      ).toBe(true);
    });

    await expect(response).resolves.toEqual({ ok: true });
    expect(nano.getNanoAvailability).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith({
      target: "sidepanel",
      type: "engine-status",
      nano: "unavailable",
      listening: false,
      mic: "denied",
    });
  });

  it("shows the existing panel workflow for a clipboard action result", async () => {
    nano.getNanoAvailability.mockReset();
    nano.getNanoAvailability.mockResolvedValue("unavailable");
    nano.respondOneSentence.mockReset();
    nano.respondOneSentence.mockResolvedValue(
      "Screenshot ready. Click Copy in Sotto.",
    );
    const sendMessage = vi.fn().mockImplementation(
      async (message: { target?: string }) =>
        message.target === "worker" ? { ok: true } : undefined,
    );
    let onMessage:
      | ((
          message: unknown,
          sender: unknown,
          respond: (response: unknown) => void,
        ) => boolean | void)
      | undefined;

    vi.stubGlobal("navigator", {
      permissions: {
        query: vi.fn().mockResolvedValue({ state: "granted" }),
      },
    });
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
    });
    vi.stubGlobal("chrome", {
      runtime: {
        getURL: vi.fn((path: string) => `chrome-extension://sotto/${path}`),
        sendMessage,
        onMessage: {
          addListener: vi.fn((listener) => {
            onMessage = listener;
          }),
        },
      },
    });

    await import("../src/offscreen.js");
    if (!onMessage) throw new Error("Offscreen message listener was not installed");

    const workflow = {
      kind: "clipboard-write",
      id: "clipboard-test",
      requiresFocus: true,
      requiresUserActivation: true,
      buttonLabel: "Copy screenshot",
      item: {
        kind: "image",
        mimeType: "image/png",
        dataUrl: "data:image/png;base64,c2NyZWVuc2hvdA==",
      },
    } as const;
    const response = new Promise<unknown>((resolve) => {
      onMessage?.(
        {
          target: "offscreen",
          type: "action-result",
          transcript: "take a screenshot",
          command: { action: "screenshot", destination: "copy" },
          result: {
            spoken: "Screenshot ready. Click Copy in Sotto.",
            workflow,
          },
        },
        {},
        resolve,
      );
    });

    await expect(response).resolves.toEqual({ ok: true });
    expect(sendMessage).toHaveBeenCalledWith({
      target: "sidepanel",
      type: "screenshot-ready",
      workflow,
    });
    expect(sendMessage).toHaveBeenCalledWith({
      target: "worker",
      type: "speak",
      text: "Screenshot ready. Click Copy in Sotto.",
      heard: "take a screenshot",
      did: "Screenshot ready. Click Copy in Sotto.",
      timings: { input: "voice" },
    });
  });

  it("aborts a pending page task when a new transcript barges in", async () => {
    nano.getNanoAvailability.mockResolvedValue("unavailable");
    let taskSignal: AbortSignal | undefined;
    nano.askPageWithPrompt.mockImplementation(
      async (
        _question: string,
        _pageText: string,
        options: { readonly signal?: AbortSignal },
      ) => {
        taskSignal = options.signal;
        return new Promise<string>((_resolve, reject) => {
          options.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      },
    );
    const sendMessage = vi.fn().mockImplementation(
      async (message: { readonly target?: string }) =>
        message.target === "worker" ? { ok: true } : undefined,
    );
    let onMessage:
      | ((
          message: unknown,
          sender: unknown,
          respond: (response: unknown) => void,
        ) => boolean | void)
      | undefined;
    vi.stubGlobal("navigator", {
      permissions: {
        query: vi.fn().mockResolvedValue({ state: "denied" }),
      },
    });
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
    });
    vi.stubGlobal("chrome", {
      runtime: {
        getURL: vi.fn((path: string) => `chrome-extension://sotto/${path}`),
        sendMessage,
        onMessage: {
          addListener: vi.fn((listener) => {
            onMessage = listener;
          }),
        },
      },
    });

    await import("../src/offscreen.js");
    if (!onMessage) throw new Error("Offscreen message listener was not installed");

    const pageResponse = new Promise<unknown>((resolve) => {
      onMessage?.(
        {
          target: "offscreen",
          type: "page-task",
          task: {
            role: "ask-page",
            pageText: "Page data",
            question: "What happened?",
          },
        },
        {},
        resolve,
      );
    });
    await vi.waitFor(() => expect(taskSignal).toBeDefined());

    const transcriptResponse = new Promise<unknown>((resolve) => {
      onMessage?.(
        {
          target: "offscreen",
          type: "parse-transcript",
          transcript: "new command",
        },
        {},
        resolve,
      );
    });

    await expect(transcriptResponse).resolves.toEqual({ ok: true });
    await expect(pageResponse).resolves.toEqual({
      ok: false,
      error: { name: "Error", message: "Aborted" },
    });
    expect(taskSignal?.aborted).toBe(true);
  });
});

describe("local inference host characterization", () => {
  it("keeps the current premium voice setup race behavior", async () => {
    const finishSetup: Array<() => void> = [];
    premium.init.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishSetup.push(resolve);
        }),
    );
    const harness = await installPremiumOffscreen();

    const first = harness.message({ type: "prepare-premium-tts" });
    const second = harness.message({ type: "prepare-premium-tts" });
    await vi.waitFor(() => expect(premium.init).toHaveBeenCalledTimes(2));

    for (const finish of finishSetup) finish();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { ok: true },
      { ok: true },
    ]);
    expect(premium.init).toHaveBeenCalledTimes(2);
    expect(harness.values).toMatchObject({
      premiumTtsDownloaded: true,
      premiumTtsEnabled: true,
    });
  });

  it("starts premium voice recovery after a WebGPU speech failure", async () => {
    premium.speak.mockRejectedValueOnce(new Error("WebGPU device lost"));
    const harness = await installPremiumOffscreen();
    await harness.message({ type: "prepare-premium-tts" });

    await expect(
      harness.message({
        type: "premium-speak",
        utteranceId: "recovery-test",
        text: "Recover the voice.",
      }),
    ).resolves.toEqual({
      ok: false,
      error: { name: "Error", message: "WebGPU device lost" },
    });

    await vi.waitFor(() => expect(premium.init).toHaveBeenCalledTimes(2));
    expect(premium.stop).toHaveBeenCalledOnce();
    expect(premium.dispose).toHaveBeenCalledOnce();
    expect(harness.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        target: "sidepanel",
        type: "premium-tts-state",
        state: "downloading",
        error: "WebGPU device lost",
      }),
    );
  });

  it("uses the Prompt API fallback after the native summarizer fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const harness = await installPremiumOffscreen();
    const destroy = vi.fn();
    vi.stubGlobal("Summarizer", {
      availability: vi.fn().mockResolvedValue("available"),
      create: vi.fn().mockResolvedValue({
        summarize: vi.fn().mockRejectedValue(new Error("native failed")),
        destroy,
      }),
    });
    nano.summarizeWithPrompt.mockResolvedValue("Prompt API summary.");

    await expect(
      harness.message({
        type: "page-task",
        task: {
          role: "summarize",
          pageText: "Page data",
        },
      }),
    ).resolves.toEqual({ ok: true, value: "Prompt API summary." });

    expect(destroy).toHaveBeenCalledOnce();
    expect(nano.summarizeWithPrompt).toHaveBeenCalledWith(
      "Page data",
      { signal: expect.any(AbortSignal) },
    );
  });

  it("finishes page-task cancellation before parsing a barge-in transcript", async () => {
    const events: string[] = [];
    nano.askPageWithPrompt.mockImplementation(
      async (
        _question: string,
        _pageText: string,
        options: { readonly signal?: AbortSignal },
      ) =>
        new Promise<string>((_resolve, reject) => {
          options.signal?.addEventListener(
            "abort",
            () => {
              events.push("page-aborted");
              reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
          );
        }),
    );
    nano.parseCommand.mockImplementation(async () => {
      events.push("transcript-parsed");
      return { action: "unknown", reason: "No command matched." };
    });
    const harness = await installPremiumOffscreen();

    const page = harness.message({
      type: "page-task",
      task: {
        role: "ask-page",
        pageText: "Page data",
        question: "What happened?",
      },
    });
    await vi.waitFor(() =>
      expect(nano.askPageWithPrompt).toHaveBeenCalledOnce()
    );
    const transcript = harness.message({
      type: "parse-transcript",
      transcript: "new command",
    });

    await expect(transcript).resolves.toEqual({ ok: true });
    await expect(page).resolves.toEqual({
      ok: false,
      error: { name: "Error", message: "Aborted" },
    });
    expect(events).toEqual(["page-aborted", "transcript-parsed"]);
    expect(harness.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        target: "worker",
        type: "execute-command",
        transcript: "new command",
      }),
    );
  });
});
