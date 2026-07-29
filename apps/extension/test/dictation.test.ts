import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DICTATION_SILENCE_MS,
  DictationSilenceTimer,
  DictationTargetSession,
  formatDictationText,
  isDictationExitPhrase,
  routeTranscriptForMode,
} from "../src/dictation.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("dictation transcript routing", () => {
  it("matches exit phrases without case or partial-word errors", () => {
    expect(isDictationExitPhrase("STOP DICTATION")).toBe(true);
    expect(isDictationExitPhrase("Please end dictation now.")).toBe(true);
    expect(isDictationExitPhrase("exit Dictation")).toBe(true);
    expect(isDictationExitPhrase("unstoppable dictation")).toBe(false);
    expect(isDictationExitPhrase("stop dictational text")).toBe(false);
  });

  it("changes only the two supported punctuation words", () => {
    expect(
      formatDictationText(
        "First line new line Second line NEW PARAGRAPH Final line comma",
      ),
    ).toBe("First line\nSecond line\n\nFinal line comma");
  });

  it("does not call the parser while dictation is active", async () => {
    const parse = vi.fn(async () => undefined);
    const insert = vi.fn(async () => undefined);

    await routeTranscriptForMode("active", "open a new tab", {
      parse,
      insert,
      exit: vi.fn(async () => undefined),
      stopPlayback: vi.fn(async () => undefined),
    });

    expect(parse).not.toHaveBeenCalled();
    expect(insert).toHaveBeenCalledWith("open a new tab");
  });

  it("routes playback stop without ending dictation", async () => {
    const exit = vi.fn(async () => undefined);
    const stopPlayback = vi.fn(async () => undefined);
    const insert = vi.fn(async () => undefined);

    await routeTranscriptForMode("active", "Stop reading.", {
      parse: vi.fn(async () => undefined),
      insert,
      exit,
      stopPlayback,
    });

    expect(stopPlayback).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });
});

describe("dictation safety state", () => {
  const target = {
    tabId: 4,
    frameId: 0,
    documentId: "document-a",
    href: "https://example.test/one",
    targetId: "field-a",
  } as const;

  it("pauses when the focused text field changes", () => {
    const session = new DictationTargetSession();
    session.start(target);

    expect(
      session.validate({ ...target, targetId: "field-b" }),
    ).toBe(false);
    expect(session.state).toBe("paused");
  });

  it("resumes only for the captured text field", () => {
    const session = new DictationTargetSession();
    session.start(target);
    session.pause();

    expect(session.resume({ ...target, frameId: 1 })).toBe(false);
    expect(session.state).toBe("paused");
    expect(session.resume(target)).toBe(true);
    expect(session.state).toBe("active");
  });

  it("ends after 60 seconds without a reset", () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const timer = new DictationSilenceTimer(onTimeout);
    timer.reset();

    vi.advanceTimersByTime(DICTATION_SILENCE_MS - 1);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledOnce();
  });
});
