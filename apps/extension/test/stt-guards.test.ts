import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assessSttAudio,
  hasRepeatedNgram,
  isPlausibleSttText,
  SpeechContextRing,
  sttTokenLimit,
  transcribeWithSttGuards,
} from "../src/stt-guards.js";

function voicedAudio(milliseconds = 400, amplitude = 0.05): Float32Array {
  const samples = Math.round(16_000 * milliseconds / 1_000);
  return Float32Array.from(
    { length: samples },
    (_value, index) => amplitude * Math.sin(index * Math.PI / 8),
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("STT acoustic and hallucination guards", () => {
  it.each([
    ["non-finite", (() => {
      const audio = voicedAudio();
      audio[10] = Number.NaN;
      return audio;
    })()],
    ["positive infinity", (() => {
      const audio = voicedAudio();
      audio[10] = Number.POSITIVE_INFINITY;
      return audio;
    })()],
    ["negative infinity", (() => {
      const audio = voicedAudio();
      audio[10] = Number.NEGATIVE_INFINITY;
      return audio;
    })()],
    ["under 300 ms voiced", voicedAudio(280)],
    ["very low RMS", voicedAudio(500, 0.0001)],
    ["extreme clipping", new Float32Array(8_000).fill(100)],
    ["sustained clipping", new Float32Array(8_000).fill(1)],
  ])("emits vad-rejected for %s input", async (_name, audio) => {
    const transcribe = vi.fn().mockResolvedValue("should not run");

    await expect(
      transcribeWithSttGuards({ audio, transcribe }),
    ).resolves.toEqual({
      ok: false,
      diagnostic: "vad-rejected",
      retried: false,
    });
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("accepts exact acoustic thresholds without crediting a partial frame", () => {
    const oneSampleShort = new Float32Array(4_799).fill(0.005);
    const exactDuration = new Float32Array(4_800).fill(0.005);
    const exactRmsLength = 13_334;
    const exactRms = new Float32Array(exactRmsLength);
    exactRms.fill(
      0.003 * Math.sqrt(exactRmsLength / 4_800),
      0,
      4_800,
    );

    expect(assessSttAudio(oneSampleShort).accepted).toBe(false);
    expect(assessSttAudio(exactDuration)).toMatchObject({
      accepted: true,
      voicedMs: 300,
    });
    expect(assessSttAudio(exactRms).rms).toBeCloseTo(0.003, 7);
    expect(assessSttAudio(exactRms).accepted).toBe(true);
  });

  it("bounds transcript tokens by duration and rejects repeated n-grams", async () => {
    expect(sttTokenLimit(1)).toBe(15);
    expect(sttTokenLimit(100)).toBe(96);
    expect(
      hasRepeatedNgram("go there go there go there go there"),
    ).toBe(true);
    expect(hasRepeatedNgram("go now go now stop")).toBe(false);
    expect(
      isPlausibleSttText(
        "a a a b b b c c c d d d e e e",
        16_000,
      ),
    ).toBe(false);
    const atLimit = Array.from({ length: 15 }, (_value, index) => `w${index}`)
      .join(" ");
    expect(isPlausibleSttText(atLimit, 16_000)).toBe(true);
    expect(isPlausibleSttText(`${atLimit} overflow`, 16_000)).toBe(false);

    const audio = voicedAudio(400);
    const result = await transcribeWithSttGuards({
      audio,
      transcribe: vi.fn().mockResolvedValue(
        "go there go there go there go there",
      ),
    });
    expect(result).toEqual({
      ok: false,
      diagnostic: "blank-result",
      retried: false,
    });
  });

  it("retries one strong-evidence blank with expanded context exactly once", async () => {
    const audio = voicedAudio(400);
    const expanded = new Float32Array(audio.length + 4_096);
    expanded.set(audio, 2_048);
    const transcribe = vi.fn()
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("open the calendar");
    const expandedAudio = vi.fn().mockResolvedValue(expanded);

    await expect(
      transcribeWithSttGuards({
        audio,
        expandedAudio,
        transcribe,
      }),
    ).resolves.toEqual({
      ok: true,
      text: "open the calendar",
      retried: true,
    });
    expect(transcribe).toHaveBeenNthCalledWith(1, audio);
    expect(transcribe).toHaveBeenCalledTimes(2);
    const retryAudio = transcribe.mock.calls[1]?.[0] as Float32Array;
    expect(retryAudio).not.toBe(expanded);
    expect(Math.max(...retryAudio)).toBeCloseTo(0.1, 5);
    expect(expandedAudio).toHaveBeenCalledTimes(1);
  });

  it("emits blank-result after the single expanded-context retry is blank", async () => {
    const audio = voicedAudio();
    const expanded = new Float32Array(audio.length + 1_024);
    expanded.set(audio, 512);
    const transcribe = vi.fn().mockResolvedValue("");

    await expect(
      transcribeWithSttGuards({
        audio,
        expandedAudio: vi.fn().mockResolvedValue(expanded),
        transcribe,
      }),
    ).resolves.toEqual({
      ok: false,
      diagnostic: "blank-result",
      retried: true,
    });
    expect(transcribe).toHaveBeenCalledTimes(2);
  });

  it("distinguishes timeout and WebGPU failure diagnostics", async () => {
    vi.useFakeTimers();
    const audio = voicedAudio();
    const timed = transcribeWithSttGuards({
      audio,
      timeoutMs: 25,
      transcribe: () => new Promise<string>(() => undefined),
    });
    await vi.advanceTimersByTimeAsync(25);
    await expect(timed).resolves.toEqual({
      ok: false,
      diagnostic: "timeout",
      retried: false,
    });

    await expect(
      transcribeWithSttGuards({
        audio,
        transcribe: vi.fn().mockRejectedValue(
          new Error("WebGPU device lost during allocation"),
        ),
      }),
    ).resolves.toEqual({
      ok: false,
      diagnostic: "webgpu-failed",
      retried: false,
    });
  });

  it("marks a timeout on the one expanded inference as retried", async () => {
    vi.useFakeTimers();
    const audio = voicedAudio();
    const expanded = new Float32Array(audio.length + 1_024);
    expanded.set(audio, 512);
    const transcribe = vi.fn()
      .mockResolvedValueOnce("")
      .mockImplementationOnce(() => new Promise<string>(() => undefined));
    const pending = transcribeWithSttGuards({
      audio,
      expandedAudio: vi.fn().mockResolvedValue(expanded),
      timeoutMs: 25,
      transcribe,
    });

    await vi.advanceTimersByTimeAsync(25);

    await expect(pending).resolves.toEqual({
      ok: false,
      diagnostic: "timeout",
      retried: true,
    });
    expect(transcribe).toHaveBeenCalledTimes(2);
  });

  it("preserves a 256/192 ms primary VAD envelope and expands retry context", async () => {
    const ring = new SpeechContextRing();
    for (let index = 0; index < 17; index += 1) {
      ring.onFrame(new Float32Array(512).fill(index + 1));
    }
    ring.onSpeechStart();
    const primary = voicedAudio();
    const capture = ring.onSpeechEnd(primary);
    for (let index = 0; index < 8; index += 1) {
      ring.onFrame(new Float32Array(512).fill(100 + index));
    }

    const expanded = await capture.expanded();

    expect(expanded.length).toBe(primary.length + 16 * 512);
    expect(expanded[0]).toBe(1);
    expect(expanded.at(-1)).toBe(107);
    expect(assessSttAudio(primary).accepted).toBe(true);
    ring.dispose();
  });
});
