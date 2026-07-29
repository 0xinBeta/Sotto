import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nano = vi.hoisted(() => ({
  askPageWithPrompt: vi.fn(),
  askScreenWithPrompt: vi.fn(),
  createParserSession: vi.fn(),
  createTranslatorSession: vi.fn(),
  detectSourceLanguage: vi.fn(),
  getNanoAvailability: vi.fn(),
  parseCommand: vi.fn(),
  respondOneSentence: vi.fn(),
  rewriteWithPrompt: vi.fn(),
  summarizeWithPrompt: vi.fn(),
}));
const premium = vi.hoisted(() => ({
  engineOptions: [] as unknown[],
  init: vi.fn(),
  speak: vi.fn(),
  stop: vi.fn(),
  setVoice: vi.fn(),
  prewarm: vi.fn(),
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
const engineLoaders = vi.hoisted(() => ({
  loadKokoroTtsEngine: vi.fn(),
  loadParakeetSttEngine: vi.fn(),
}));

vi.mock("@ricky0123/vad-web", () => ({
  MicVAD: { new: vad.create },
}));
vi.mock("@sotto/actions", () => ({
  default: [],
  TRANSLATE_LANGUAGE_CODES: [
    "ar",
    "zh",
    "nl",
    "en",
    "fr",
    "de",
    "hi",
    "it",
    "ja",
    "ko",
    "pl",
    "pt",
    "ru",
    "es",
    "tr",
  ],
}));
vi.mock("@sotto/core", () => ({
  ActionRegistry: class ActionRegistry {},
}));
vi.mock("@sotto/nano", () => ({
  askPageWithPrompt: nano.askPageWithPrompt,
  askScreenWithPrompt: nano.askScreenWithPrompt,
  createParserSession: nano.createParserSession,
  createResponderSession: vi.fn(),
  createTranslatorSession: nano.createTranslatorSession,
  detectSourceLanguage: nano.detectSourceLanguage,
  getNanoAvailability: nano.getNanoAvailability,
  parseCommand: nano.parseCommand,
  respondOneSentence: nano.respondOneSentence,
  rewriteWithPrompt: nano.rewriteWithPrompt,
  summarizeWithPrompt: nano.summarizeWithPrompt,
}));
vi.mock("@sotto/stt/moonshine", () => ({
  MoonshineEngine: class MoonshineEngine {
    constructor(options?: unknown) {
      speech.moonshineOptions.push(options);
    }
    init = speech.moonshineInit;
    transcribe = speech.moonshineTranscribe;
    dispose = speech.moonshineDispose;
  },
}));
vi.mock("../src/premium-engine-loaders.js", () => ({
  loadKokoroTtsEngine: engineLoaders.loadKokoroTtsEngine,
  loadParakeetSttEngine: engineLoaders.loadParakeetSttEngine,
}));

beforeEach(() => {
  engineLoaders.loadKokoroTtsEngine.mockResolvedValue(
    class KokoroTtsEngine {
      backend = "webgpu" as const;
      constructor(options?: unknown) {
        premium.engineOptions.push(options);
      }
      init = premium.init;
      speak = premium.speak;
      stop = premium.stop;
      setVoice = premium.setVoice;
      prewarm = premium.prewarm;
      probe = premium.probe;
      dispose = premium.dispose;
    },
  );
  engineLoaders.loadParakeetSttEngine.mockResolvedValue(
    class ParakeetSttEngine {
      constructor(options?: unknown) {
        speech.parakeetOptions.push(options);
      }
      init = speech.parakeetInit;
      transcribe = speech.parakeetTranscribe;
      dispose = speech.parakeetDispose;
    },
  );
});

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
  premium.prewarm.mockResolvedValue(undefined);
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
    async (message: {
      readonly target?: string;
      readonly type?: string;
      readonly area?: string;
      readonly keys?: readonly string[];
      readonly values?: Record<string, unknown>;
    }) => {
      if (message.target !== "worker") return undefined;
      if (message.type === "storage-get") {
        if (options.storageGetError) {
          return {
            ok: false,
            error: {
              name: options.storageGetError.name,
              message: options.storageGetError.message,
            },
          };
        }
        const selected = message.keys ?? [];
        return {
          ok: true,
          value: Object.fromEntries(
            selected
              .filter((key) => key in values)
              .map((key) => [key, values[key]]),
          ),
        };
      }
      if (message.type === "storage-set") {
        Object.assign(values, message.values);
      }
      return { ok: true };
    },
  );
  let onMessage: OffscreenListener | undefined;
  let unloadListener: (() => void) | undefined;
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
    addEventListener: vi.fn(
      (type: string, listener: EventListenerOrEventListenerObject) => {
        if (type === "unload" && typeof listener === "function") {
          unloadListener = () => listener({} as Event);
        }
      },
    ),
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
    unload: () => unloadListener?.(),
  };
}

afterEach(() => {
  vi.useRealTimers();
  nano.askPageWithPrompt.mockReset();
  nano.askScreenWithPrompt.mockReset();
  nano.createParserSession.mockReset();
  nano.createTranslatorSession.mockReset();
  nano.detectSourceLanguage.mockReset();
  nano.parseCommand.mockReset();
  vi.resetModules();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  nano.rewriteWithPrompt.mockReset();
  nano.summarizeWithPrompt.mockReset();
  premium.init.mockReset();
  premium.engineOptions.splice(0);
  premium.speak.mockReset();
  premium.stop.mockReset();
  premium.setVoice.mockReset();
  premium.prewarm.mockReset();
  premium.probe.mockReset();
  premium.dispose.mockReset();
  engineLoaders.loadKokoroTtsEngine.mockReset();
  engineLoaders.loadParakeetSttEngine.mockReset();
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
  it("disables live transcript preview without WebGPU", async () => {
    const harness = await installPremiumOffscreen();

    await harness.message({ type: "get-status" });
    expect(harness.sendMessage).toHaveBeenCalledWith({
      target: "sidepanel",
      type: "live-transcript-preview-state",
      available: false,
      enabled: false,
    });

    await harness.message({
      type: "set-live-transcript-preview-enabled",
      enabled: true,
    });
    expect(harness.values.liveTranscriptPreview).toBeUndefined();
    expect(harness.sendMessage).toHaveBeenLastCalledWith({
      target: "sidepanel",
      type: "live-transcript-preview-state",
      available: false,
      enabled: false,
    });
  });

  it("defaults live transcript preview ON with WebGPU and saves the toggle", async () => {
    const harness = await installPremiumOffscreen({ webGpu: true });

    await harness.message({ type: "get-status" });
    expect(harness.sendMessage).toHaveBeenCalledWith({
      target: "sidepanel",
      type: "live-transcript-preview-state",
      available: true,
      enabled: true,
    });

    await harness.message({
      type: "set-live-transcript-preview-enabled",
      enabled: false,
    });
    expect(harness.values.liveTranscriptPreview).toBe(false);
  });

  it("runs an exact alias before Nano and uses its one-time execution id", async () => {
    const harness = await installPremiumOffscreen();
    harness.sendMessage.mockImplementation(
      async (message: {
        readonly target?: string;
        readonly type?: string;
      }) => {
        if (
          message.target === "worker" &&
          message.type === "resolve-command-alias"
        ) {
          return {
            ok: true,
            value: {
              kind: "alias",
              aliasExecutionId: "alias-execution-1",
            },
          };
        }
        if (
          message.target === "worker" &&
          message.type === "execute-command-alias"
        ) {
          return { ok: true, value: { spoken: "Opened the saved page." } };
        }
        return message.target === "worker" ? { ok: true } : undefined;
      },
    );

    await harness.message({
      type: "parse-transcript",
      transcript: "daily page!!!",
      timings: { input: "typed" },
    });

    expect(nano.parseCommand).not.toHaveBeenCalled();
    expect(harness.sendMessage).toHaveBeenCalledWith({
      target: "worker",
      type: "resolve-command-alias",
      transcript: "daily page!!!",
    });
    expect(harness.sendMessage).toHaveBeenCalledWith({
      target: "worker",
      type: "execute-command-alias",
      transcript: "daily page!!!",
      aliasExecutionId: "alias-execution-1",
      timings: {
        input: "typed",
        parseMs: expect.any(Number),
      },
    });
  });

  it("uses a spoken alias phrase for capture without calling Nano", async () => {
    const harness = await installPremiumOffscreen();
    harness.sendMessage.mockImplementation(
      async (message: {
        readonly target?: string;
        readonly type?: string;
      }) =>
        message.target === "worker" &&
          message.type === "resolve-command-alias"
          ? { ok: true, value: { kind: "phrase" } }
          : message.target === "worker"
            ? { ok: true }
            : undefined,
    );

    await harness.message({
      type: "parse-transcript",
      transcript: "My daily page",
    });

    expect(nano.parseCommand).not.toHaveBeenCalled();
    expect(harness.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({
        target: "worker",
        type: "execute-command",
      }),
    );
  });

  it("publishes parse diagnostics to the panel log", async () => {
    nano.parseCommand.mockImplementation(
      async (options: {
        readonly onDiagnostic?: (diagnostic: {
          readonly diagnostic: string;
          readonly message: string;
        }) => void;
      }) => {
        options.onDiagnostic?.({
          diagnostic: "prompt-error",
          message:
            "Stage 1 prompt failed. NotSupportedError: Constraint rejected",
        });
        return { action: "unknown" };
      },
    );
    const harness = await installPremiumOffscreen();

    await harness.message({
      type: "parse-transcript",
      transcript: "open a new tab",
      timings: { input: "typed" },
    });

    expect(harness.sendMessage).toHaveBeenCalledWith({
      target: "sidepanel",
      type: "parse-diagnostic",
      diagnostic: "prompt-error",
      message:
        "Stage 1 prompt failed. NotSupportedError: Constraint rejected",
    });
  });

  it("publishes partial speech only to the transcript display", async () => {
    nano.parseCommand.mockResolvedValue({ action: "unknown" });
    speech.moonshineTranscribe
      .mockResolvedValueOnce("open")
      .mockResolvedValueOnce("open the calendar");
    const harness = await installPremiumOffscreen({ webGpu: true });

    await harness.message({ type: "start-listening" });
    await vi.waitFor(() => expect(speech.moonshineInit).toHaveBeenCalled());
    const vadOptions = vad.create.mock.calls[0]?.[0] as {
      onSpeechStart(): void;
      onFrameProcessed(
        probabilities: Record<string, number>,
        frame: Float32Array,
      ): void;
      onSpeechEnd(audio: Float32Array): void;
    };
    vadOptions.onSpeechStart();
    const frame = new Float32Array(512).fill(0.02);
    for (let index = 0; index < 19; index += 1) {
      vadOptions.onFrameProcessed({}, frame);
    }

    await vi.waitFor(() =>
      expect(harness.sendMessage).toHaveBeenCalledWith({
        target: "sidepanel",
        type: "partial-transcript",
        text: "open",
      })
    );
    expect(
      harness.sendMessage.mock.calls.some(
        ([message]) =>
          message.target === "worker" &&
          message.type === "execute-command",
      ),
    ).toBe(false);
    expect(nano.parseCommand).not.toHaveBeenCalled();

    const audio = new Float32Array(16_000).fill(0.02);
    vadOptions.onSpeechEnd(audio);
    await vi.waitFor(() =>
      expect(harness.sendMessage).toHaveBeenCalledWith({
        target: "sidepanel",
        type: "transcript",
        text: "open the calendar",
      })
    );
    expect(nano.parseCommand).toHaveBeenCalledOnce();
  });

  it("routes selected non-English speech to typing without Nano", async () => {
    const harness = await installPremiumOffscreen({ webGpu: true });
    speech.parakeetTranscribe.mockResolvedValue("ready");
    await harness.message({ type: "prepare-premium-stt" });
    await harness.message({
      type: "set-speech-language",
      language: "es",
    });
    harness.sendMessage.mockClear();
    await harness.message({ type: "start-listening" });
    await vi.waitFor(() => {
      const states = harness.sendMessage.mock.calls.map(
        ([message]) => message as {
          readonly type?: string;
          readonly state?: string;
          readonly language?: string;
        },
      );
      const warmingIndex = states.findIndex(
        (message) =>
          message.type === "premium-stt-state" &&
          message.state === "warming" &&
          message.language === "es",
      );
      expect(warmingIndex).toBeGreaterThanOrEqual(0);
      expect(
        states.slice(warmingIndex + 1).some(
          (message) =>
            message.type === "premium-stt-state" &&
            message.state === "active" &&
            message.language === "es",
        ),
      ).toBe(true);
    });
    speech.parakeetTranscribe.mockResolvedValue("abre una pestaña");
    const vadOptions = vad.create.mock.calls[0]?.[0] as {
      onSpeechEnd(audio: Float32Array): void;
    };
    const audio = new Float32Array(16_000).fill(0.02);

    vadOptions.onSpeechEnd(audio);

    await vi.waitFor(() =>
      expect(harness.sendMessage).toHaveBeenCalledWith({
        target: "worker",
        type: "execute-non-english-dictation",
        transcript: "abre una pestaña",
        timings: {
          input: "voice",
          sttMs: expect.any(Number),
          parseMs: 0,
        },
      })
    );
    expect(speech.parakeetTranscribe).toHaveBeenLastCalledWith(
      audio,
      { language: "es" },
    );
    expect(nano.parseCommand).not.toHaveBeenCalled();
  });

  it("does not decode or publish command partials during dictation", async () => {
    const harness = await installPremiumOffscreen({ webGpu: true });

    await harness.message({ type: "dictation-start" });
    await vi.waitFor(() => expect(speech.moonshineInit).toHaveBeenCalled());
    const vadOptions = vad.create.mock.calls[0]?.[0] as {
      onSpeechStart(): void;
      onFrameProcessed(
        probabilities: Record<string, number>,
        frame: Float32Array,
      ): void;
    };
    vadOptions.onSpeechStart();
    const frame = new Float32Array(512).fill(0.02);
    for (let index = 0; index < 19; index += 1) {
      vadOptions.onFrameProcessed({}, frame);
    }
    await Promise.resolve();

    expect(speech.moonshineTranscribe).not.toHaveBeenCalled();
    expect(harness.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({
        target: "sidepanel",
        type: "partial-transcript",
      }),
    );
  });

  it("serializes screen inference and releases each transported image", async () => {
    const resolvers: Array<
      (value: {
        availability: "available";
        text: string;
      }) => void
    > = [];
    const received: Array<{
      readonly image: Blob;
      readonly question: string | undefined;
    }> = [];
    nano.askScreenWithPrompt.mockImplementation(
      async (image: Blob, question: string | undefined) => {
        received.push({ image, question });
        return await new Promise((resolve) => {
          resolvers.push(resolve);
        });
      },
    );
    const harness = await installPremiumOffscreen();
    const firstTask = {
      imageDataUrl: "data:image/png;base64,Zmlyc3Q=",
      question: "What is first?",
    };
    const secondTask = {
      imageDataUrl: "data:image/png;base64,c2Vjb25k",
      question: "What is second?",
    };

    const first = harness.message({
      type: "screen-task",
      task: firstTask,
    });
    await vi.waitFor(() =>
      expect(nano.askScreenWithPrompt).toHaveBeenCalledTimes(1)
    );
    const second = harness.message({
      type: "screen-task",
      task: secondTask,
    });
    await Promise.resolve();
    expect(nano.askScreenWithPrompt).toHaveBeenCalledTimes(1);

    resolvers[0]?.({
      availability: "available",
      text: "First screen.",
    });
    await expect(first).resolves.toEqual({
      ok: true,
      value: {
        availability: "available",
        text: "First screen.",
      },
    });
    expect(firstTask.imageDataUrl).toBe("");
    await vi.waitFor(() =>
      expect(nano.askScreenWithPrompt).toHaveBeenCalledTimes(2)
    );
    resolvers[1]?.({
      availability: "available",
      text: "Second screen.",
    });
    await expect(second).resolves.toEqual({
      ok: true,
      value: {
        availability: "available",
        text: "Second screen.",
      },
    });
    expect(secondTask.imageDataUrl).toBe("");
    expect(received.map(({ question }) => question)).toEqual([
      "What is first?",
      "What is second?",
    ]);
    expect(received.every(({ image }) => image.type === "image/png")).toBe(true);
  });

  it("runs translation in the offscreen document and publishes download progress", async () => {
    const translate = vi.fn().mockResolvedValue("Hola");
    const destroy = vi.fn();
    nano.detectSourceLanguage.mockResolvedValue("en");
    nano.createTranslatorSession.mockImplementation(
      async (options: {
        readonly onDownloadProgress?: (
          progress: { readonly loaded: number; readonly total: 1 },
        ) => void;
      }) => {
        options.onDownloadProgress?.({ loaded: 0.5, total: 1 });
        return {
          ok: true,
          availability: "downloadable",
          session: { translate, destroy },
        };
      },
    );
    const harness = await installPremiumOffscreen();

    await expect(
      harness.message({
        type: "translation-task",
        task: {
          pageText: "Hello",
          pageLanguage: "en-US",
          targetLanguage: "es",
        },
      }),
    ).resolves.toEqual({
      ok: true,
      value: {
        availability: "downloadable",
        text: "Hola",
      },
    });
    expect(nano.detectSourceLanguage).toHaveBeenCalledWith(
      "Hello",
      expect.objectContaining({
        fallbackLanguage: "en-US",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(translate).toHaveBeenCalledWith(
      "Hello",
      { signal: expect.any(AbortSignal) },
    );
    expect(destroy).toHaveBeenCalledOnce();
    expect(harness.sendMessage).toHaveBeenCalledWith({
      target: "sidepanel",
      type: "model-progress",
      model: "translator",
      progress: 0.5,
    });
  });

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
    const sendMessage = vi.fn().mockImplementation(
      async (message: {
        readonly target?: string;
        readonly type?: string;
        readonly keys?: readonly string[];
        readonly values?: Record<string, unknown>;
      }) => {
        if (message.target !== "worker") return undefined;
        if (message.type === "storage-get") {
          return {
            ok: true,
            value: Object.fromEntries(
              (message.keys ?? [])
                .filter((key) => key in values)
                .map((key) => [key, values[key]]),
            ),
          };
        }
        if (message.type === "storage-set") {
          Object.assign(values, message.values);
        }
        return { ok: true };
      },
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

  it("loads premium engine modules only when setup starts", async () => {
    const harness = await installPremiumOffscreen({ webGpu: true });

    await expect(harness.message({ type: "get-status" })).resolves.toEqual({
      ok: true,
    });
    expect(engineLoaders.loadKokoroTtsEngine).not.toHaveBeenCalled();
    expect(engineLoaders.loadParakeetSttEngine).not.toHaveBeenCalled();

    await expect(
      harness.message({ type: "prepare-premium-tts" }),
    ).resolves.toEqual({ ok: true });
    expect(engineLoaders.loadKokoroTtsEngine).toHaveBeenCalledOnce();
    expect(engineLoaders.loadParakeetSttEngine).not.toHaveBeenCalled();
    const kokoroOptions = premium.engineOptions[0] as {
      runtimeUrl(path: string): string;
    };
    expect(kokoroOptions.runtimeUrl("assets/ort-kokoro/runtime.wasm")).toBe(
      "chrome-extension://sotto/assets/ort-kokoro/runtime.wasm",
    );

    await expect(
      harness.message({ type: "prepare-premium-stt" }),
    ).resolves.toEqual({ ok: true });
    expect(engineLoaders.loadParakeetSttEngine).toHaveBeenCalledOnce();
    const parakeetOptions = speech.parakeetOptions[0] as {
      runtimeUrl(path: string): string;
    };
    expect(
      parakeetOptions.runtimeUrl("assets/ort-parakeet/runtime.wasm"),
    ).toBe("chrome-extension://sotto/assets/ort-parakeet/runtime.wasm");
  });

  it("reports a Kokoro module load failure as a setup failure", async () => {
    const harness = await installPremiumOffscreen();
    engineLoaders.loadKokoroTtsEngine.mockRejectedValueOnce(
      new Error("Kokoro chunk could not load"),
    );

    await expect(
      harness.message({ type: "prepare-premium-tts" }),
    ).resolves.toEqual({
      ok: false,
      error: {
        name: "Error",
        message: "Kokoro chunk could not load",
      },
    });
    expect(premium.init).not.toHaveBeenCalled();
    expect(harness.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        target: "sidepanel",
        type: "premium-tts-state",
        state: "error",
        error: "Kokoro chunk could not load",
      }),
    );
  });

  it("reports a Parakeet module load failure and keeps tiny STT", async () => {
    const harness = await installPremiumOffscreen({ webGpu: true });
    engineLoaders.loadParakeetSttEngine.mockRejectedValueOnce(
      new Error("Parakeet chunk could not load"),
    );

    await expect(
      harness.message({ type: "prepare-premium-stt" }),
    ).resolves.toEqual({
      ok: false,
      error: {
        name: "Error",
        message: "Parakeet chunk could not load",
      },
    });
    expect(speech.moonshineInit).toHaveBeenCalledOnce();
    expect(speech.parakeetInit).not.toHaveBeenCalled();
    expect(harness.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        target: "sidepanel",
        type: "premium-stt-state",
        state: "error",
        error: "Parakeet chunk could not load",
      }),
    );
  });

  it("persists a voice selection and sends it to the resident engine", async () => {
    const harness = await installPremiumOffscreen();
    await harness.message({ type: "prepare-premium-tts" });

    await expect(
      harness.message({
        type: "set-premium-tts-voice",
        voice: "bf_emma",
      }),
    ).resolves.toEqual({ ok: true });
    expect(harness.values.premiumTtsVoice).toBe("bf_emma");
    expect(premium.setVoice).toHaveBeenCalledWith("bf_emma");
    expect(harness.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        target: "sidepanel",
        type: "premium-tts-state",
        voice: "bf_emma",
      }),
    );

    await expect(
      harness.message({
        type: "premium-speak",
        utteranceId: "selected-voice",
        text: "Selected voice.",
      }),
    ).resolves.toEqual({ ok: true });
    expect(premium.speak).toHaveBeenCalledWith(
      "Selected voice.",
      expect.objectContaining({ voice: "bf_emma" }),
    );
  });

  it("clamps premium speech settings at the playback boundary", async () => {
    const harness = await installPremiumOffscreen();
    await harness.message({ type: "prepare-premium-tts" });

    await expect(
      harness.message({
        type: "premium-speak",
        utteranceId: "bounded-settings",
        text: "Bounded settings.",
        rate: 20,
        volume: -3,
      }),
    ).resolves.toEqual({ ok: true });

    expect(premium.speak).toHaveBeenCalledWith(
      "Bounded settings.",
      expect.objectContaining({
        rate: 2,
        volume: 0,
      }),
    );
  });

  it("restores a stored voice when the premium engine reloads", async () => {
    const harness = await installPremiumOffscreen({
      initialStorage: {
        premiumTtsDownloaded: true,
        premiumTtsEnabled: true,
        premiumTtsVoice: "bf_emma",
      },
    });

    await harness.message({ type: "prepare-premium-tts" });

    expect(premium.engineOptions).toContainEqual(
      expect.objectContaining({ voice: "bf_emma" }),
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

  it("hands STT natural-speech VAD gating (300 ms pad, 800 ms redemption, 250 ms voiced)", async () => {
    const harness = await installPremiumOffscreen();

    await expect(
      harness.message({ type: "start-listening" }),
    ).resolves.toEqual({ ok: true });

    expect(vad.create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "v5",
        onnxWASMBasePath: "chrome-extension://sotto/assets/ort-vad/",
        positiveSpeechThreshold: 0.5,
        negativeSpeechThreshold: 0.35,
        preSpeechPadMs: 300,
        redemptionMs: 800,
        minSpeechMs: 250,
      }),
    );
  });

  it("skips warm-up after recent activity and runs after 30 idle seconds", async () => {
    vi.useFakeTimers();
    const harness = await installPremiumOffscreen();
    await harness.message({ type: "prepare-premium-tts" });
    premium.prewarm.mockClear();

    await expect(
      harness.message({ type: "start-listening" }),
    ).resolves.toEqual({ ok: true });
    await vi.waitFor(() => expect(premium.prewarm).toHaveBeenCalledOnce());

    await harness.message({ type: "stop-listening" });
    await vi.advanceTimersByTimeAsync(650);
    await harness.message({ type: "start-listening" });
    await Promise.resolve();
    expect(premium.prewarm).toHaveBeenCalledOnce();

    await harness.message({ type: "stop-listening" });
    await vi.advanceTimersByTimeAsync(30_000);
    await harness.message({
      type: "parse-transcript",
      transcript: "open a new tab",
      timings: { input: "typed" },
    });
    await harness.message({ type: "start-listening" });
    await Promise.resolve();
    expect(premium.prewarm).toHaveBeenCalledOnce();

    await harness.message({ type: "stop-listening" });
    await vi.advanceTimersByTimeAsync(30_650);
    await harness.message({ type: "start-listening" });
    await vi.waitFor(() =>
      expect(premium.prewarm).toHaveBeenCalledTimes(2)
    );
  });

  it("keeps safe exchange memory until offscreen teardown", async () => {
    const harness = await installPremiumOffscreen();
    nano.parseCommand
      .mockResolvedValueOnce({
        action: "tabs",
        operation: "switch",
        target: "GitHub",
      })
      .mockResolvedValue({ action: "tabs", operation: "count" });
    harness.sendMessage.mockImplementation(
      async (message: {
        readonly target?: string;
        readonly type?: string;
      }) =>
        message.target === "worker" && message.type === "execute-command"
          ? {
              ok: true,
              value: {
                spoken: "Switched to a private tab title.",
                pageText: {
                  text: "Private page text",
                  speech: "long",
                },
                data: { modelOutput: "Private model output" },
              },
            }
          : message.target === "worker"
            ? { ok: true }
            : undefined,
    );

    await harness.message({
      type: "parse-transcript",
      transcript: "switch to GitHub",
    });
    await harness.message({
      type: "parse-transcript",
      transcript: "no, count them instead",
    });

    const recentMemory = nano.parseCommand.mock.calls[1]?.[0]?.memory;
    expect(recentMemory).toEqual([
      {
        transcript: "switch to GitHub",
        command: {
          action: "tabs",
          operation: "switch",
          target: "GitHub",
        },
        resultSummary: "Command completed.",
      },
    ]);
    expect(JSON.stringify(recentMemory)).not.toContain("private");
    expect(JSON.stringify(recentMemory)).not.toContain("pageText");
    expect(JSON.stringify(recentMemory)).not.toContain("modelOutput");

    harness.unload();
    await harness.message({
      type: "parse-transcript",
      transcript: "no, count them instead",
    });

    expect(nano.parseCommand.mock.calls[2]?.[0]?.memory).toEqual([]);
  });

  it("does not record a confirmation reply as a completed exchange", async () => {
    const harness = await installPremiumOffscreen();
    nano.parseCommand
      .mockResolvedValueOnce({
        action: "tabs",
        operation: "switch",
        target: "GitHub",
      })
      .mockResolvedValueOnce({
        action: "tabs",
        operation: "count",
      })
      .mockResolvedValueOnce({ action: "unknown" });
    let executions = 0;
    harness.sendMessage.mockImplementation(
      async (message: {
        readonly target?: string;
        readonly type?: string;
      }) => {
        if (
          message.target !== "worker" ||
          message.type !== "execute-command"
        ) {
          return message.target === "worker" ? { ok: true } : undefined;
        }
        executions += 1;
        return executions === 2
          ? { ok: true }
          : { ok: true, value: { spoken: "Done." } };
      },
    );

    await harness.message({
      type: "parse-transcript",
      transcript: "switch to GitHub",
    });
    await harness.message({
      type: "parse-transcript",
      transcript: "yes",
    });
    await harness.message({
      type: "parse-transcript",
      transcript: "one more command",
    });

    expect(nano.parseCommand.mock.calls[2]?.[0]?.memory).toEqual([
      {
        transcript: "switch to GitHub",
        command: {
          action: "tabs",
          operation: "switch",
          target: "GitHub",
        },
        resultSummary: "Command completed.",
      },
    ]);
  });

  it("does not wait for warm-up before listening starts", async () => {
    premium.prewarm.mockImplementation(
      () => new Promise<void>(() => undefined),
    );
    const harness = await installPremiumOffscreen();
    await harness.message({ type: "prepare-premium-tts" });

    await expect(
      harness.message({ type: "start-listening" }),
    ).resolves.toEqual({ ok: true });
    expect(vad.create).toHaveBeenCalledOnce();
    expect(harness.sendMessage).toHaveBeenCalledWith({
      target: "sidepanel",
      type: "listening-state",
      listening: true,
    });
  });

  it("logs warm-up failures without publishing a pipeline error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const harness = await installPremiumOffscreen();
    await harness.message({ type: "prepare-premium-tts" });
    premium.prewarm.mockRejectedValue(new Error("prewarm failed"));
    nano.getNanoAvailability.mockResolvedValue("available");
    nano.createParserSession.mockResolvedValue({
      ok: false,
      availability: "available",
      error: {
        name: "OperationError",
        message: "parser warm-up failed",
      },
    });

    await expect(
      harness.message({ type: "start-listening" }),
    ).resolves.toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        "Sotto pipeline warm-up failed",
        expect.any(Error),
      )
    );

    expect(
      harness.sendMessage.mock.calls
        .map(([message]) => message)
        .filter((message) => message.type === "pipeline-error"),
    ).toEqual([]);
  });

  it("cancels Nano warm-up before speech transcription", async () => {
    const order: string[] = [];
    const harness = await installPremiumOffscreen();
    nano.getNanoAvailability.mockResolvedValue("available");
    nano.createParserSession
      .mockImplementationOnce(
        (options: { readonly signal?: AbortSignal }) =>
          new Promise((resolve) => {
            order.push("nano:warm");
            options.signal?.addEventListener(
              "abort",
              () => {
                order.push("nano:cancel");
                resolve({
                  ok: false,
                  availability: "available",
                  error: {
                    name: "AbortError",
                    message: "warm-up cancelled",
                  },
                });
              },
              { once: true },
            );
          }),
      )
      .mockResolvedValue({
        ok: true,
        availability: "available",
        session: {
          destroyed: false,
          prompt: vi.fn(),
          destroy: vi.fn(),
        },
      });
    speech.moonshineTranscribe.mockImplementation(async () => {
      order.push("stt");
      return "open a new tab";
    });
    nano.parseCommand.mockResolvedValue({ action: "unknown" });

    await harness.message({ type: "start-listening" });
    await vi.waitFor(() => expect(order).toEqual(["nano:warm"]));
    const vadOptions = vad.create.mock.calls[0]?.[0] as {
      onSpeechEnd(audio: Float32Array): void;
    };
    const audio = new Float32Array(16_000);
    audio.fill(0.02);
    vadOptions.onSpeechEnd(audio);

    await vi.waitFor(() => expect(order).toContain("stt"));
    expect(order.indexOf("nano:cancel")).toBeLessThan(
      order.indexOf("stt"),
    );
    expect(
      harness.sendMessage.mock.calls
        .map(([message]) => message)
        .filter((message) => message.type === "pipeline-error"),
    ).toEqual([]);
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
      voice: "af_heart",
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

  it("speaks the exact page-control result without responder changes", async () => {
    const harness = await installPremiumOffscreen();
    harness.sendMessage.mockClear();
    nano.respondOneSentence.mockReset();

    await expect(
      harness.message({
        type: "action-result",
        transcript: "zoom in",
        command: { action: "page-control", operation: "zoom-in" },
        result: { spoken: "Zoom one hundred forty percent." },
      }),
    ).resolves.toEqual({ ok: true });

    expect(nano.respondOneSentence).not.toHaveBeenCalled();
    expect(harness.sendMessage).toHaveBeenCalledWith({
      target: "sidepanel",
      type: "earcon",
      kind: "complete",
    });
    expect(harness.sendMessage).toHaveBeenCalledWith({
      target: "worker",
      type: "speak",
      text: "Zoom one hundred forty percent.",
      heard: "zoom in",
      did: "Zoom one hundred forty percent.",
      timings: { input: "voice" },
    });
  });

  it("speaks the exact media result in brief mode", async () => {
    const harness = await installPremiumOffscreen();
    harness.sendMessage.mockClear();
    nano.respondOneSentence.mockReset();

    await expect(
      harness.message({
        type: "action-result",
        transcript: "pause the video",
        command: { action: "media", operation: "pause" },
        result: { spoken: "Paused." },
        verbosity: "brief",
      }),
    ).resolves.toEqual({ ok: true });

    expect(nano.respondOneSentence).not.toHaveBeenCalled();
    expect(harness.sendMessage).toHaveBeenCalledWith({
      target: "worker",
      type: "speak",
      text: "Paused.",
      heard: "pause the video",
      did: "Paused.",
      timings: { input: "voice" },
    });
  });

  it("suppresses the completion earcon when quiet mode is on", async () => {
    const harness = await installPremiumOffscreen();
    harness.sendMessage.mockImplementation(
      async (message: {
        readonly target?: string;
        readonly type?: string;
      }) =>
        message.target === "worker"
          ? {
              ok: true,
              ...(message.type === "get-quiet-mode"
                ? { value: true }
                : {}),
            }
          : undefined,
    );

    await harness.message({
      type: "action-result",
      transcript: "zoom in",
      command: { action: "page-control", operation: "zoom-in" },
      result: { spoken: "Zoom one hundred forty percent." },
    });

    expect(harness.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({
        target: "sidepanel",
        type: "earcon",
      }),
    );
    expect(harness.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        target: "worker",
        type: "speak",
      }),
    );
  });

  it("speaks the settings confirmation without responder changes", async () => {
    const harness = await installPremiumOffscreen();
    harness.sendMessage.mockClear();
    nano.respondOneSentence.mockReset();

    await expect(
      harness.message({
        type: "action-result",
        transcript: "be brief",
        command: {
          action: "settings",
          operation: "verbosity-brief",
        },
        result: { spoken: "Brief mode is on." },
        verbosity: "brief",
      }),
    ).resolves.toEqual({ ok: true });

    expect(nano.respondOneSentence).not.toHaveBeenCalled();
    expect(harness.sendMessage).toHaveBeenCalledWith({
      target: "worker",
      type: "speak",
      text: "Brief mode is on.",
      heard: "be brief",
      did: "Brief mode is on.",
      timings: { input: "voice" },
    });
  });

  it.each([
    ["normal", "Opened a new window."],
    ["brief", "Opened."],
  ] as const)(
    "uses the %s window confirmation without responder changes",
    async (verbosity, spoken) => {
      const harness = await installPremiumOffscreen();
      harness.sendMessage.mockClear();
      nano.respondOneSentence.mockReset();

      await expect(
        harness.message({
          type: "action-result",
          transcript: "open a new window",
          command: { action: "windows", operation: "new" },
          result: { spoken: "Opened a new window." },
          verbosity,
        }),
      ).resolves.toEqual({ ok: true });

      expect(nano.respondOneSentence).not.toHaveBeenCalled();
      expect(harness.sendMessage).toHaveBeenCalledWith({
        target: "worker",
        type: "speak",
        text: spoken,
        heard: "open a new window",
        did: "Opened a new window.",
        timings: { input: "voice" },
      });
    },
  );

  it("keeps the window tab count in brief mode", async () => {
    const harness = await installPremiumOffscreen();
    harness.sendMessage.mockClear();
    nano.respondOneSentence.mockReset();
    const confirmation = "Close this window with 12 tabs? Say yes.";

    await expect(
      harness.message({
        type: "action-result",
        transcript: "close this window",
        command: { action: "windows", operation: "close" },
        result: { spoken: confirmation },
        verbosity: "brief",
      }),
    ).resolves.toEqual({ ok: true });

    expect(nano.respondOneSentence).not.toHaveBeenCalled();
    expect(harness.sendMessage).toHaveBeenCalledWith({
      target: "worker",
      type: "speak",
      text: confirmation,
      heard: "close this window",
      did: confirmation,
      timings: { input: "voice" },
    });
  });

  it("keeps informational lines unchanged in brief mode", async () => {
    const harness = await installPremiumOffscreen();
    harness.sendMessage.mockClear();
    nano.respondOneSentence.mockReset();

    await expect(
      harness.message({
        type: "action-result",
        transcript: "how many tabs are open",
        command: { action: "tabs", operation: "count" },
        result: { spoken: "You have 12 tabs open." },
        verbosity: "brief",
      }),
    ).resolves.toEqual({ ok: true });

    expect(nano.respondOneSentence).not.toHaveBeenCalled();
    expect(harness.sendMessage).toHaveBeenCalledWith({
      target: "worker",
      type: "speak",
      text: "You have 12 tabs open.",
      heard: "how many tabs are open",
      did: "You have 12 tabs open.",
      timings: { input: "voice" },
    });
  });

  it("routes known confirmations through the brief responder", async () => {
    nano.respondOneSentence.mockReset();
    nano.respondOneSentence.mockImplementation(
      async (options: { readonly result: { readonly spoken: string } }) =>
        options.result.spoken,
    );
    const harness = await installPremiumOffscreen();
    harness.sendMessage.mockClear();

    await expect(
      harness.message({
        type: "action-result",
        transcript: "close this tab",
        command: { action: "tabs", operation: "close" },
        result: { spoken: "Closed the tab." },
        verbosity: "brief",
      }),
    ).resolves.toEqual({ ok: true });

    expect(nano.respondOneSentence).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({ spoken: "Closed." }),
        verbosity: "brief",
      }),
    );
    expect(harness.sendMessage).toHaveBeenCalledWith({
      target: "worker",
      type: "speak",
      text: "Closed.",
      heard: "close this tab",
      did: "Closed the tab.",
      timings: { input: "voice" },
    });
  });

  it("speaks the exact screen-model fallback without responder changes", async () => {
    const harness = await installPremiumOffscreen();
    harness.sendMessage.mockClear();
    nano.respondOneSentence.mockReset();

    await expect(
      harness.message({
        type: "action-result",
        transcript: "what is on my screen",
        command: { action: "ask-screen" },
        result: {
          spoken: "Screen questions need a newer Chrome AI model.",
        },
      }),
    ).resolves.toEqual({ ok: true });

    expect(nano.respondOneSentence).not.toHaveBeenCalled();
    expect(harness.sendMessage).toHaveBeenCalledWith({
      target: "worker",
      type: "speak",
      text: "Screen questions need a newer Chrome AI model.",
      heard: "what is on my screen",
      did: "Screen questions need a newer Chrome AI model.",
      timings: { input: "voice" },
    });
  });

  it("aborts a pending page task when a new transcript barges in", async () => {
    nano.getNanoAvailability.mockResolvedValue("unavailable");
    nano.parseCommand.mockResolvedValue({ action: "unknown" });
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
