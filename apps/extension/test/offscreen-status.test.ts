import { afterEach, describe, expect, it, vi } from "vitest";

const nano = vi.hoisted(() => ({
  getNanoAvailability: vi.fn(),
  respondOneSentence: vi.fn(),
}));

vi.mock("@ricky0123/vad-web", () => ({
  MicVAD: { new: vi.fn() },
}));
vi.mock("@sotto/actions", () => ({ default: [] }));
vi.mock("@sotto/core", () => ({
  ActionRegistry: class ActionRegistry {},
}));
vi.mock("@sotto/nano", () => ({
  createParserSession: vi.fn(),
  createResponderSession: vi.fn(),
  getNanoAvailability: nano.getNanoAvailability,
  parseCommand: vi.fn(),
  respondOneSentence: nano.respondOneSentence,
}));
vi.mock("@sotto/stt", () => ({
  MoonshineEngine: class MoonshineEngine {
    init = vi.fn();
    transcribe = vi.fn();
    dispose = vi.fn();
  },
}));

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("offscreen fail-soft status", () => {
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
});
