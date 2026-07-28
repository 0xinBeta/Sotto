import { afterEach, describe, expect, it, vi } from "vitest";

import {
  chunkTextForTts,
  MAX_TTS_CHUNK_LENGTH,
  MAX_TTS_UTTERANCE_LENGTH,
  normalizeTtsText,
  SystemTtsEngine,
} from "../src/index.js";

function installTts(
  speak: ReturnType<typeof vi.fn> = vi.fn(),
): {
  readonly getVoices: ReturnType<typeof vi.fn>;
  readonly speak: ReturnType<typeof vi.fn>;
  readonly stop: ReturnType<typeof vi.fn>;
} {
  const getVoices = vi.fn().mockResolvedValue([
    { voiceName: "Local", lang: "en-US", remote: false },
  ]);
  const stop = vi.fn();
  vi.stubGlobal("chrome", {
    tts: { getVoices, speak, stop },
  });
  return { getVoices, speak, stop };
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("adversarial TTS boundaries", () => {
  it("does no voice lookup or playback for empty normalized long text", async () => {
    const harness = installTts();

    await expect(
      new SystemTtsEngine().speakLong(" \r\n\t\u00a0 "),
    ).resolves.toBeUndefined();

    expect(chunkTextForTts(" \r\n\t\u00a0 ")).toEqual([]);
    expect(harness.getVoices).not.toHaveBeenCalled();
    expect(harness.speak).not.toHaveBeenCalled();
  });

  it("accepts exactly 32,767 UTF-16 code units and rejects 32,768", async () => {
    const callbacks: chrome.tts.TtsOptions[] = [];
    const harness = installTts(
      vi.fn((_text: string, options: chrome.tts.TtsOptions) => {
        callbacks.push(options);
      }),
    );
    const engine = new SystemTtsEngine();
    const boundary = engine.speak("x".repeat(MAX_TTS_UTTERANCE_LENGTH));
    await vi.waitFor(() => expect(harness.speak).toHaveBeenCalledOnce());
    callbacks[0]?.onEvent?.({ type: "end" } as chrome.tts.TtsEvent);
    await expect(boundary).resolves.toBeUndefined();

    await expect(
      engine.speak("x".repeat(MAX_TTS_UTTERANCE_LENGTH + 1)),
    ).rejects.toThrow("must be shorter than 32,768 characters");
    expect(harness.speak).toHaveBeenCalledTimes(1);
  });

  it("prefers a sentence boundary before a hard split", () => {
    const first = `${"a".repeat(2_998)}.`;
    const chunks = chunkTextForTts(`${first} ${"b".repeat(2_500)}.`);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(first);
    expect(chunks.every((chunk) => chunk.length <= MAX_TTS_CHUNK_LENGTH)).toBe(
      true,
    );
  });

  it("never splits an emoji surrogate pair in hard chunks", () => {
    const source = `a${"🙂".repeat(5_000)}`;
    const chunks = chunkTextForTts(source);

    expect(chunks.join("")).toBe(source);
    expect(chunks.every((chunk) => !hasUnpairedSurrogate(chunk))).toBe(true);
    expect(chunks.every((chunk) => chunk.length <= MAX_TTS_CHUNK_LENGTH)).toBe(
      true,
    );
  });

  it("ignores a stale chunk callback after barge-in stop", async () => {
    const callbacks: chrome.tts.TtsOptions[] = [];
    const harness = installTts(
      vi.fn((_text: string, options: chrome.tts.TtsOptions) => {
        callbacks.push(options);
      }),
    );
    const progress = vi.fn();
    const engine = new SystemTtsEngine();
    const reading = engine.speakLong(
      `${"First sentence. ".repeat(220)} ${"Second sentence. ".repeat(220)}`,
      { onProgress: progress },
    );
    await vi.waitFor(() => expect(harness.speak).toHaveBeenCalledOnce());

    engine.stop();
    const progressCountAtStop = progress.mock.calls.length;
    callbacks[0]?.onEvent?.({
      type: "word",
      charIndex: 50,
    } as chrome.tts.TtsEvent);
    callbacks[0]?.onEvent?.({ type: "end" } as chrome.tts.TtsEvent);

    await expect(reading).resolves.toBeUndefined();
    expect(harness.speak).toHaveBeenCalledTimes(1);
    expect(progress).toHaveBeenCalledTimes(progressCountAtStop);
  });

  it("ignores non-finite Chrome progress indices without poisoning totals", async () => {
    const callbacks: chrome.tts.TtsOptions[] = [];
    const harness = installTts(
      vi.fn((_text: string, options: chrome.tts.TtsOptions) => {
        callbacks.push(options);
      }),
    );
    const progress = vi.fn();
    const text = `${"Sentence one. ".repeat(220)} ${"Sentence two. ".repeat(220)}`;
    const reading = new SystemTtsEngine().speakLong(text, { onProgress: progress });
    await vi.waitFor(() => expect(harness.speak).toHaveBeenCalledOnce());

    callbacks[0]?.onEvent?.({
      type: "word",
      charIndex: Number.NaN,
    } as chrome.tts.TtsEvent);
    callbacks[0]?.onEvent?.({ type: "end" } as chrome.tts.TtsEvent);
    await vi.waitFor(() => expect(harness.speak).toHaveBeenCalledTimes(2));
    callbacks[1]?.onEvent?.({ type: "end" } as chrome.tts.TtsEvent);
    await expect(reading).resolves.toBeUndefined();

    const charIndices = progress.mock.calls.map(
      ([event]) => (event as { charIndex: number }).charIndex,
    );
    expect(charIndices.every(Number.isFinite)).toBe(true);
    expect(charIndices.at(-1)).toBe(normalizeTtsText(text).length);
  });
});
