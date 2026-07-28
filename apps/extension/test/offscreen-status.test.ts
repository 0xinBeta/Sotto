import { afterEach, describe, expect, it, vi } from "vitest";

const nano = vi.hoisted(() => ({
  askPageWithPrompt: vi.fn(),
  getNanoAvailability: vi.fn(),
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

vi.mock("@ricky0123/vad-web", () => ({
  MicVAD: { new: vi.fn() },
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
  parseCommand: vi.fn(),
  respondOneSentence: nano.respondOneSentence,
  rewriteWithPrompt: nano.rewriteWithPrompt,
  summarizeWithPrompt: nano.summarizeWithPrompt,
}));
vi.mock("@sotto/stt", () => ({
  MoonshineEngine: class MoonshineEngine {
    init = vi.fn();
    transcribe = vi.fn();
    dispose = vi.fn();
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
} = {}) {
  nano.getNanoAvailability.mockResolvedValue("unavailable");
  premium.init.mockResolvedValue(undefined);
  premium.dispose.mockResolvedValue(undefined);
  const values = { ...options.initialStorage };
  const sendMessage = vi.fn().mockImplementation(
    async (message: { readonly target?: string }) =>
      message.target === "worker" ? { ok: true } : undefined,
  );
  let onMessage: OffscreenListener | undefined;
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
  nano.askPageWithPrompt.mockReset();
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
      target: "sidepanel",
      type: "action-log",
      heard: "take a screenshot",
      did: "Screenshot ready. Click Copy in Sotto.",
    });
    expect(sendMessage).toHaveBeenCalledWith({
      target: "worker",
      type: "speak",
      text: "Screenshot ready. Click Copy in Sotto.",
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
