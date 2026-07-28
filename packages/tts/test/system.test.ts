import { afterEach, describe, expect, it, vi } from "vitest";

import { SystemTtsEngine } from "../src/index.js";

function installTts(
  voices: chrome.tts.TtsVoice[],
  speak: ReturnType<typeof vi.fn>,
): void {
  vi.stubGlobal("chrome", {
    tts: {
      getVoices: vi.fn().mockResolvedValue(voices),
      speak,
      stop: vi.fn(),
    },
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SystemTtsEngine", () => {
  it("selects a local matching voice and resolves on playback end", async () => {
    const speak = vi.fn(
      (_text: string, options: chrome.tts.TtsOptions) => {
        options.onEvent?.({ type: "end" } as chrome.tts.TtsEvent);
      },
    );
    installTts(
      [
        { voiceName: "Remote", lang: "en-US", remote: true },
        { voiceName: "Local", lang: "en-GB", remote: false },
      ],
      speak,
    );

    await expect(
      new SystemTtsEngine().speak("Done", { lang: "en-US" }),
    ).resolves.toBeUndefined();
    expect(speak).toHaveBeenCalledWith(
      "Done",
      expect.objectContaining({
        voiceName: "Local",
        lang: "en-GB",
        enqueue: false,
      }),
    );
  });

  it("rejects instead of silently accepting a missing local voice", async () => {
    installTts(
      [{ voiceName: "Remote", lang: "en-US", remote: true }],
      vi.fn(),
    );

    await expect(new SystemTtsEngine().speak("Done")).rejects.toThrow(
      "No local TTS voice is available for en-US",
    );
  });

  it("rejects playback errors and terminal-event timeouts", async () => {
    const failedSpeak = vi.fn(
      (_text: string, options: chrome.tts.TtsOptions) => {
        options.onEvent?.({
          type: "error",
          errorMessage: "voice failed",
        } as chrome.tts.TtsEvent);
      },
    );
    installTts(
      [{ voiceName: "Local", lang: "en-US", remote: false }],
      failedSpeak,
    );
    await expect(new SystemTtsEngine().speak("Done")).rejects.toThrow(
      "System TTS playback failed: voice failed",
    );

    vi.useFakeTimers();
    installTts(
      [{ voiceName: "Local", lang: "en-US", remote: false }],
      vi.fn(),
    );
    const pending = expect(
      new SystemTtsEngine().speak("No terminal event"),
    ).rejects.toThrow("System TTS playback timed out");
    await vi.advanceTimersByTimeAsync(5_000);
    await pending;
  });
});
