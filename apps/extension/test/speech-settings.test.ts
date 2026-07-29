import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_SPEECH_SETTINGS,
  normalizeSpeechSettings,
  SpeechSettingsStore,
  SpeechSettingsTtsEngine,
  type SpeechSettingsStorage,
} from "../src/speech-settings.js";

function storageHarness(
  initial: Record<string, unknown> = {},
): {
  readonly storage: SpeechSettingsStorage;
  readonly values: Record<string, unknown>;
  readonly set: ReturnType<typeof vi.fn>;
} {
  const values = { ...initial };
  const set = vi.fn(async (updates: Record<string, unknown>) => {
    Object.assign(values, updates);
  });
  return {
    values,
    set,
    storage: {
      get: vi.fn(async (keys: readonly string[]) =>
        Object.fromEntries(
          keys
            .filter((key) => key in values)
            .map((key) => [key, values[key]]),
        )
      ),
      set,
    },
  };
}

describe("speech settings", () => {
  it("restores persisted values and uses safe defaults for invalid values", async () => {
    const persisted = storageHarness({
      speechRate: 1.4,
      speechVolume: 0.65,
      responseVerbosity: "brief",
    });
    await expect(
      new SpeechSettingsStore(persisted.storage).get(),
    ).resolves.toEqual({
      rate: 1.4,
      volume: 0.65,
      verbosity: "brief",
    });

    expect(
      normalizeSpeechSettings({
        speechRate: Number.NaN,
        speechVolume: "loud",
        responseVerbosity: "long",
      }),
    ).toEqual(DEFAULT_SPEECH_SETTINGS);
  });

  it("clamps both bounds before it persists settings", async () => {
    const harness = storageHarness();
    const store = new SpeechSettingsStore(harness.storage);

    await expect(
      store.update({ rate: 20, volume: -4, verbosity: "brief" }),
    ).resolves.toEqual({ rate: 2, volume: 0, verbosity: "brief" });
    expect(harness.values).toMatchObject({
      speechRate: 2,
      speechVolume: 0,
      responseVerbosity: "brief",
    });

    await expect(
      store.update({ rate: -20, volume: 4 }),
    ).resolves.toEqual({ rate: 0.5, volume: 1, verbosity: "brief" });
    expect(harness.set).toHaveBeenLastCalledWith({
      speechRate: 0.5,
      speechVolume: 1,
      responseVerbosity: "brief",
    });
  });

  it("keeps the current utterance settings and updates the next utterance", async () => {
    const harness = storageHarness({
      speechRate: 1,
      speechVolume: 0.8,
    });
    const store = new SpeechSettingsStore(harness.storage);
    let finishFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const delegate = {
      playbackState: "idle" as const,
      speak: vi.fn()
        .mockImplementationOnce(async () => await firstGate)
        .mockResolvedValue(undefined),
      speakLong: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn(),
      pause: vi.fn(() => true),
      resume: vi.fn(() => true),
      skip: vi.fn(() => true),
    };
    const engine = new SpeechSettingsTtsEngine(delegate, store);

    const first = engine.speak("First.");
    await vi.waitFor(() => expect(delegate.speak).toHaveBeenCalledOnce());
    await store.update({ rate: 1.8, volume: 0.25 });
    finishFirst();
    await first;
    await engine.speak("Second.");
    await engine.speakLong("Third.");

    expect(delegate.speak).toHaveBeenNthCalledWith(
      1,
      "First.",
      { rate: 1, volume: 0.8 },
    );
    expect(delegate.speak).toHaveBeenNthCalledWith(
      2,
      "Second.",
      { rate: 1.8, volume: 0.25 },
    );
    expect(delegate.speakLong).toHaveBeenCalledWith(
      "Third.",
      { rate: 1.8, volume: 0.25 },
    );
  });
});
