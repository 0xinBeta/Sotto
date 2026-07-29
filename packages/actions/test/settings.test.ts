import { describe, expect, it, vi } from "vitest";

import { validateSchema } from "@sotto/core";
import type {
  SpeechSettingsActionServices,
  SpeechSettingsVoice,
} from "@sotto/core";
import settingsAction, {
  findVoiceMatch,
  nextSpeechRate,
  nextSpeechVolume,
  settingsSchema,
} from "../src/settings/index.js";

const VOICES = [
  { id: "af_bella", label: "Bella", accent: "US" },
  { id: "bf_emma", label: "Emma", accent: "GB" },
  { id: "bf_isabella", label: "Isabella", accent: "GB" },
] as const satisfies readonly SpeechSettingsVoice[];

function services(
  overrides: Partial<SpeechSettingsActionServices> = {},
): SpeechSettingsActionServices {
  return {
    get: vi.fn(async () => ({
      rate: 1,
      volume: 0.6,
      verbosity: "normal" as const,
      voices: VOICES,
    })),
    setRate: vi.fn(async () => undefined),
    setVolume: vi.fn(async () => undefined),
    setVoice: vi.fn(async () => undefined),
    setVerbosity: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("voice-controlled settings action", () => {
  it.each([
    [1, "rate-slower", 0.75],
    [1, "rate-faster", 1.25],
    [1.9, "rate-faster", 2],
    [0.6, "rate-slower", 0.5],
    [1.75, "rate-normal", 1],
  ] as const)("steps rate %s with %s to %s", (current, operation, expected) => {
    expect(nextSpeechRate(current, operation)).toBe(expected);
  });

  it.each([
    [0.6, "volume-quieter", 0.4],
    [0.6, "volume-louder", 0.8],
    [0.9, "volume-louder", 1],
    [0.1, "volume-quieter", 0],
    [0.2, "volume-full", 1],
  ] as const)(
    "steps volume %s with %s to %s",
    (current, operation, expected) => {
      expect(nextSpeechVolume(current, operation)).toBe(expected);
    },
  );

  it("filters by accent before it uses fuzzy voice matching", () => {
    expect(findVoiceMatch(VOICES, "switch to the British voice")).toEqual(
      VOICES[1],
    );
    expect(findVoiceMatch(VOICES, "British Bella")).toEqual(VOICES[2]);
    expect(findVoiceMatch(VOICES, "use the Ema voice")).toEqual(VOICES[1]);
    expect(findVoiceMatch(VOICES, "American voice")).toEqual(VOICES[0]);
  });

  it("fails closed when no local voice matches", () => {
    expect(findVoiceMatch(VOICES, "use the Zzzzz voice")).toBeUndefined();
  });

  it("uses a closed operation enum and permits a target only for voice", () => {
    for (const command of [
      { action: "settings", operation: "rate-slower" },
      { action: "settings", operation: "rate-faster" },
      { action: "settings", operation: "rate-normal" },
      { action: "settings", operation: "volume-quieter" },
      { action: "settings", operation: "volume-louder" },
      { action: "settings", operation: "volume-full" },
      { action: "settings", operation: "voice", target: "Emma" },
      { action: "settings", operation: "verbosity-brief" },
      { action: "settings", operation: "verbosity-normal" },
    ]) {
      expect(validateSchema(settingsSchema, command).valid).toBe(true);
    }

    for (const command of [
      { action: "settings", operation: "set", setting: "speechRate" },
      { action: "settings", operation: "rate-faster", target: "volume" },
      { action: "settings", operation: "voice" },
      { action: "settings", operation: "quiet-mode-on" },
    ]) {
      expect(validateSchema(settingsSchema, command).valid).toBe(false);
    }
  });

  it("persists rate before it returns the new-rate confirmation", async () => {
    const events: string[] = [];
    const actionServices = services({
      setRate: vi.fn(async (rate) => {
        events.push(`rate:${rate}`);
      }),
    });

    const result = await settingsAction.execute(
      { action: "settings", operation: "rate-faster" },
      { settings: actionServices },
    );
    events.push(result.spoken);

    expect(events).toEqual([
      "rate:1.25",
      "This is my speed now.",
    ]);
  });

  it("routes volume, voice, and verbosity through whitelisted methods", async () => {
    const actionServices = services();

    await expect(
      settingsAction.execute(
        { action: "settings", operation: "volume-louder" },
        { settings: actionServices },
      ),
    ).resolves.toEqual({ spoken: "This is my volume now." });
    await expect(
      settingsAction.execute(
        { action: "settings", operation: "voice", target: "Ema" },
        { settings: actionServices },
      ),
    ).resolves.toEqual({ spoken: "This is my voice now." });
    await expect(
      settingsAction.execute(
        { action: "settings", operation: "verbosity-brief" },
        { settings: actionServices },
      ),
    ).resolves.toEqual({ spoken: "Brief mode is on." });
    await expect(
      settingsAction.execute(
        { action: "settings", operation: "verbosity-normal" },
        { settings: actionServices },
      ),
    ).resolves.toEqual({
      spoken: "I will use normal responses now.",
    });

    expect(actionServices.setVolume).toHaveBeenCalledWith(0.8);
    expect(actionServices.setVoice).toHaveBeenCalledWith("bf_emma");
    expect(actionServices.setVerbosity).toHaveBeenNthCalledWith(1, "brief");
    expect(actionServices.setVerbosity).toHaveBeenNthCalledWith(2, "normal");
  });

  it("does not persist an unmatched transcript voice target", async () => {
    const actionServices = services();

    await expect(
      settingsAction.execute(
        {
          action: "settings",
          operation: "voice",
          target: "Zzzzz",
        },
        { settings: actionServices },
      ),
    ).resolves.toEqual({ spoken: "I could not find that voice." });
    expect(actionServices.setVoice).not.toHaveBeenCalled();
  });
});
