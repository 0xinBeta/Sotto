import { afterEach, describe, expect, it, vi } from "vitest";

import {
  chunkTextForTts,
  MAX_TTS_CHUNK_LENGTH,
  MAX_TTS_UTTERANCE_LENGTH,
  MIN_TTS_CHUNK_LENGTH,
  normalizeTtsText,
  SystemTtsEngine,
} from "../src/index.js";

function installTts(
  voices: chrome.tts.TtsVoice[],
  speak: ReturnType<typeof vi.fn>,
): ReturnType<typeof vi.fn> {
  const stop = vi.fn();
  vi.stubGlobal("chrome", {
    tts: {
      getVoices: vi.fn().mockResolvedValue(voices),
      speak,
      stop,
    },
  });
  return stop;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SystemTtsEngine", () => {
  it("selects a local matching voice and resolves on playback end", async () => {
    const firstAudio = vi.fn();
    const speak = vi.fn(
      (_text: string, options: chrome.tts.TtsOptions) => {
        options.onEvent?.({ type: "start" } as chrome.tts.TtsEvent);
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
      new SystemTtsEngine().speak("Done", {
        lang: "en-US",
        onFirstAudio: firstAudio,
      }),
    ).resolves.toBeUndefined();
    expect(speak).toHaveBeenCalledWith(
      "Done",
      expect.objectContaining({
        voiceName: "Local",
        lang: "en-GB",
        enqueue: false,
      }),
    );
    expect(firstAudio).toHaveBeenCalledOnce();
  });

  it("passes speech rate and volume to Chrome TTS", async () => {
    const speak = vi.fn(
      (_text: string, options: chrome.tts.TtsOptions) => {
        options.onEvent?.({ type: "end" } as chrome.tts.TtsEvent);
      },
    );
    installTts(
      [{ voiceName: "Local", lang: "en-US", remote: false }],
      speak,
    );

    await new SystemTtsEngine().speak("Configured.", {
      rate: 1.7,
      volume: 0.35,
    });

    expect(speak).toHaveBeenCalledWith(
      "Configured.",
      expect.objectContaining({
        rate: 1.7,
        volume: 0.35,
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
    await vi.advanceTimersByTimeAsync(60_000);
    await pending;
  });

  it("rejects a regular utterance at or above Chrome's hard limit", async () => {
    const speak = vi.fn();
    installTts(
      [{ voiceName: "Local", lang: "en-US", remote: false }],
      speak,
    );

    await expect(
      new SystemTtsEngine().speak("x".repeat(MAX_TTS_UTTERANCE_LENGTH + 1)),
    ).rejects.toThrow("must be shorter than 32,768 characters");
    expect(speak).not.toHaveBeenCalled();
  });

  it("speaks long text one chunk at a time and reports aggregate progress", async () => {
    const callbacks: chrome.tts.TtsOptions[] = [];
    const speak = vi.fn(
      (_text: string, options: chrome.tts.TtsOptions) => {
        callbacks.push(options);
      },
    );
    installTts(
      [{ voiceName: "Local", lang: "en-US", remote: false }],
      speak,
    );
    const progress = vi.fn();
    const text = `${"First sentence. ".repeat(220)}\n\n${"Second sentence. ".repeat(220)}`;

    const reading = new SystemTtsEngine().speakLong(text, {
      onProgress: progress,
    });
    await vi.waitFor(() => expect(speak).toHaveBeenCalledTimes(1));
    expect(callbacks[0]).toBeDefined();

    callbacks[0]?.onEvent?.({
      type: "word",
      charIndex: 12,
    } as chrome.tts.TtsEvent);
    callbacks[0]?.onEvent?.({ type: "end" } as chrome.tts.TtsEvent);
    await vi.waitFor(() => expect(speak).toHaveBeenCalledTimes(2));

    const normalized = normalizeTtsText(text);
    const secondChunkOffset = normalized.indexOf(
      speak.mock.calls[1]?.[0] as string,
    );
    callbacks[1]?.onEvent?.({
      type: "sentence",
      charIndex: 7,
    } as chrome.tts.TtsEvent);
    callbacks[1]?.onEvent?.({ type: "end" } as chrome.tts.TtsEvent);
    await expect(reading).resolves.toBeUndefined();

    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({
        charIndex: 12,
        chunkIndex: 0,
        eventType: "word",
      }),
    );
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({
        charIndex: secondChunkOffset + 7,
        chunkIndex: 1,
        eventType: "sentence",
      }),
    );
    expect(progress.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({
        charIndex: normalized.length,
        totalChars: normalized.length,
        eventType: "end",
      }),
    );
  });

  it.each(["interrupted", "cancelled"] as const)(
    "does not continue a long read after %s",
    async (terminalEvent) => {
      let firstOptions: chrome.tts.TtsOptions | undefined;
      const speak = vi.fn(
        (_text: string, options: chrome.tts.TtsOptions) => {
          firstOptions ??= options;
        },
      );
      installTts(
        [{ voiceName: "Local", lang: "en-US", remote: false }],
        speak,
      );
      const reading = new SystemTtsEngine().speakLong(
        `${"Sentence one. ".repeat(220)}\n\n${"Sentence two. ".repeat(220)}`,
      );
      await vi.waitFor(() => expect(speak).toHaveBeenCalledTimes(1));

      firstOptions?.onEvent?.({
        type: terminalEvent,
      } as chrome.tts.TtsEvent);
      await expect(reading).resolves.toBeUndefined();
      expect(speak).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects and does not continue a long read after an error", async () => {
    let firstOptions: chrome.tts.TtsOptions | undefined;
    const speak = vi.fn(
      (_text: string, options: chrome.tts.TtsOptions) => {
        firstOptions ??= options;
      },
    );
    installTts(
      [{ voiceName: "Local", lang: "en-US", remote: false }],
      speak,
    );
    const reading = new SystemTtsEngine().speakLong(
      `${"Sentence one. ".repeat(220)}\n\n${"Sentence two. ".repeat(220)}`,
    );
    await vi.waitFor(() => expect(speak).toHaveBeenCalledTimes(1));

    firstOptions?.onEvent?.({
      type: "error",
      errorMessage: "engine failed",
    } as chrome.tts.TtsEvent);

    await expect(reading).rejects.toThrow(
      "System TTS playback failed: engine failed",
    );
    expect(speak).toHaveBeenCalledTimes(1);
  });

  it("resets the generous watchdog when playback makes progress", async () => {
    vi.useFakeTimers();
    let ttsOptions: chrome.tts.TtsOptions | undefined;
    const speak = vi.fn(
      (_text: string, options: chrome.tts.TtsOptions) => {
        ttsOptions = options;
      },
    );
    installTts(
      [{ voiceName: "Local", lang: "en-US", remote: false }],
      speak,
    );
    const playback = new SystemTtsEngine().speak("A short sentence.");
    await vi.advanceTimersByTimeAsync(0);
    expect(speak).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(50_000);
    ttsOptions?.onEvent?.({
      type: "word",
      charIndex: 2,
    } as chrome.tts.TtsEvent);
    await vi.advanceTimersByTimeAsync(50_000);
    ttsOptions?.onEvent?.({ type: "end" } as chrome.tts.TtsEvent);

    await expect(playback).resolves.toBeUndefined();
  });

  it("scales the watchdog duration with speech rate", async () => {
    vi.useFakeTimers();
    const speak = vi.fn();
    installTts(
      [{ voiceName: "Local", lang: "en-US", remote: false }],
      speak,
    );
    const playback = new SystemTtsEngine().speak(
      "x".repeat(1_000),
      { rate: 2 },
    );
    let settled = false;
    void playback.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const rejected = expect(playback).rejects.toThrow(
      "System TTS playback timed out",
    );

    await vi.advanceTimersByTimeAsync(74_999);
    expect(speak).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
  });

  it("stop invalidates a read immediately even when Chrome emits no event", async () => {
    const speak = vi.fn();
    const stop = installTts(
      [{ voiceName: "Local", lang: "en-US", remote: false }],
      speak,
    );
    const engine = new SystemTtsEngine();
    const reading = engine.speakLong(
      `${"Sentence one. ".repeat(220)}\n\n${"Sentence two. ".repeat(220)}`,
    );
    await vi.waitFor(() => expect(speak).toHaveBeenCalledTimes(1));
    stop.mockClear();

    engine.stop();

    expect(stop).toHaveBeenCalledTimes(1);
    await expect(reading).resolves.toBeUndefined();
    expect(speak).toHaveBeenCalledTimes(1);
  });

  it("a regular speak cancels the active long read before it starts", async () => {
    const callbacks: chrome.tts.TtsOptions[] = [];
    const speak = vi.fn(
      (_text: string, options: chrome.tts.TtsOptions) => {
        callbacks.push(options);
      },
    );
    const stop = installTts(
      [{ voiceName: "Local", lang: "en-US", remote: false }],
      speak,
    );
    const engine = new SystemTtsEngine();
    const reading = engine.speakLong(
      `${"Long sentence. ".repeat(220)}\n\n${"Another sentence. ".repeat(220)}`,
    );
    await vi.waitFor(() => expect(speak).toHaveBeenCalledTimes(1));
    stop.mockClear();

    const regular = engine.speak("New request");
    await vi.waitFor(() => expect(speak).toHaveBeenCalledTimes(2));
    expect(stop).toHaveBeenCalledTimes(1);
    callbacks[1]?.onEvent?.({ type: "end" } as chrome.tts.TtsEvent);

    await expect(Promise.all([reading, regular])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect(speak.mock.calls.map(([utterance]) => utterance)).toEqual([
      expect.not.stringContaining("Another sentence"),
      "New request",
    ]);
  });
});

describe("chunkTextForTts", () => {
  it("is deterministic, prefers paragraph boundaries, and stays moderate", () => {
    const firstParagraph = "A sentence. ".repeat(210);
    const secondParagraph = "B sentence. ".repeat(210);
    const thirdParagraph = "C sentence. ".repeat(210);
    const text = `${firstParagraph}\n\n${secondParagraph}\n\n${thirdParagraph}`;

    const chunks = chunkTextForTts(text);

    expect(chunkTextForTts(text)).toEqual(chunks);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toBe(firstParagraph.trim());
    expect(chunks[1]).toBe(secondParagraph.trim());
    for (const chunk of chunks) {
      expect(chunk.length).toBeGreaterThanOrEqual(MIN_TTS_CHUNK_LENGTH);
      expect(chunk.length).toBeLessThanOrEqual(MAX_TTS_CHUNK_LENGTH);
      expect(chunk.length).toBeLessThanOrEqual(MAX_TTS_UTTERANCE_LENGTH);
    }
  });

  it("falls back to hard deterministic splits for unbroken text", () => {
    const chunks = chunkTextForTts("x".repeat(10_001));

    expect(chunks.map((chunk) => chunk.length)).toEqual([4_000, 4_000, 2_001]);
    expect(chunks.join("")).toBe("x".repeat(10_001));
  });
});
