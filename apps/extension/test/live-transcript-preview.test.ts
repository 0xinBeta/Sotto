import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { InferenceMutex } from "../src/inference-mutex.js";
import {
  LIVE_TRANSCRIPT_PARTIAL_INTERVAL_MS,
  LiveTranscriptPreview,
  liveTranscriptPreviewEnabled,
} from "../src/live-transcript-preview.js";

const FRAME = new Float32Array(3_200);

function createPreview(options: {
  readonly decode?: (
    audio: Float32Array,
    signal: AbortSignal,
  ) => Promise<string> | undefined;
  readonly now: () => number;
  readonly shouldPublish?: () => boolean;
}) {
  const publish = vi.fn();
  const decode = vi.fn(
    options.decode ?? (async () => "open a new tab"),
  );
  const preview = new LiveTranscriptPreview({
    decode,
    publish,
    now: options.now,
    ...(options.shouldPublish === undefined
      ? {}
      : { shouldPublish: options.shouldPublish }),
  });
  preview.setEnabled(true);
  preview.start();
  return { decode, preview, publish };
}

describe("live transcript preview policy", () => {
  it("requires 1.2 seconds between partial decodes", async () => {
    let now = 0;
    const { decode, preview } = createPreview({ now: () => now });

    preview.addFrame(FRAME);
    preview.addFrame(FRAME);
    preview.addFrame(FRAME);
    expect(decode).toHaveBeenCalledOnce();

    now = LIVE_TRANSCRIPT_PARTIAL_INTERVAL_MS - 1;
    preview.addFrame(FRAME);
    preview.addFrame(FRAME);
    preview.addFrame(FRAME);
    expect(decode).toHaveBeenCalledOnce();

    now = LIVE_TRANSCRIPT_PARTIAL_INTERVAL_MS;
    preview.addFrame(new Float32Array(1));
    expect(decode).toHaveBeenCalledTimes(2);
    await Promise.resolve();
  });

  it("requires 600 milliseconds of new audio", () => {
    let now = 0;
    const { decode, preview } = createPreview({ now: () => now });

    preview.addFrame(FRAME);
    preview.addFrame(FRAME);
    preview.addFrame(FRAME);
    expect(decode).toHaveBeenCalledOnce();

    now = LIVE_TRANSCRIPT_PARTIAL_INTERVAL_MS;
    preview.addFrame(FRAME);
    preview.addFrame(FRAME);
    expect(decode).toHaveBeenCalledOnce();

    preview.addFrame(FRAME);
    expect(decode).toHaveBeenCalledTimes(2);
  });

  it("does not consume either gate when inference is busy", () => {
    let busy = true;
    const { decode, preview } = createPreview({
      now: () => 0,
      decode: () => busy ? undefined : Promise.resolve("preview"),
    });

    preview.addFrame(FRAME);
    preview.addFrame(FRAME);
    preview.addFrame(FRAME);
    expect(decode).toHaveBeenCalledOnce();

    busy = false;
    preview.addFrame(new Float32Array(1));
    expect(decode).toHaveBeenCalledTimes(2);
  });

  it("hard-skips when the inference mutex is busy", async () => {
    const mutex = new InferenceMutex();
    let release!: () => void;
    const active = mutex.run(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    await Promise.resolve();
    expect(mutex.tryRun(async () => "partial")).toBeUndefined();
    release();
    await active;
    await mutex.idle();
    await expect(mutex.tryRun(async () => "partial")).resolves.toBe(
      "partial",
    );
  });

  it("cancels an in-flight partial before the final pass", async () => {
    let resolve!: (text: string) => void;
    let partialSignal: AbortSignal | undefined;
    const { preview, publish } = createPreview({
      now: () => 0,
      decode: (_audio, signal) => {
        partialSignal = signal;
        return new Promise<string>((done) => {
          resolve = done;
        });
      },
    });

    preview.addFrame(FRAME);
    preview.addFrame(FRAME);
    preview.addFrame(FRAME);
    preview.finish();

    expect(partialSignal?.aborted).toBe(true);
    resolve("stale partial");
    await Promise.resolve();
    expect(publish).not.toHaveBeenCalled();
  });

  it("does not publish a command partial after dictation starts", async () => {
    let resolve!: (text: string) => void;
    let dictating = false;
    const { preview, publish } = createPreview({
      now: () => 0,
      shouldPublish: () => !dictating,
      decode: () =>
        new Promise<string>((done) => {
          resolve = done;
        }),
    });

    preview.addFrame(FRAME);
    preview.addFrame(FRAME);
    preview.addFrame(FRAME);
    dictating = true;
    resolve("literal dictated text");
    await Promise.resolve();

    expect(publish).not.toHaveBeenCalled();
  });

  it("defaults ON only when WebGPU is available", () => {
    expect(liveTranscriptPreviewEnabled(true, undefined)).toBe(true);
    expect(liveTranscriptPreviewEnabled(true, true)).toBe(true);
    expect(liveTranscriptPreviewEnabled(true, false)).toBe(false);
    expect(liveTranscriptPreviewEnabled(false, undefined)).toBe(false);
    expect(liveTranscriptPreviewEnabled(false, true)).toBe(false);
  });

  it("keeps the partial path display-only", () => {
    const source = readFileSync(
      new URL("../src/offscreen.ts", import.meta.url),
      "utf8",
    );
    const boundary = source.match(
      /const liveTranscriptPreview = new LiveTranscriptPreview\(\{([\s\S]*?)\n\}\);/,
    )?.[1];

    expect(boundary).toContain(
      'sendPanel({ type: "partial-transcript", text: partial })',
    );
    expect(boundary).toContain(
      'shouldPublish: () => dictationState === "inactive"',
    );
    expect(boundary).not.toMatch(
      /parseCommand|processTranscript|followUpMemory|session-history|askWorker/,
    );
  });
});
