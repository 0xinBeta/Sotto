import { afterEach, describe, expect, it, vi } from "vitest";

const nano = vi.hoisted(() => ({
  getNanoAvailability: vi.fn(),
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
  respondOneSentence: vi.fn(),
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
});
