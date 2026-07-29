import { describe, expect, it } from "vitest";

import {
  RECOVERY_ERROR_CLASSES,
  recoveryHint,
  type RecoveryErrorClass,
} from "../src/recovery-hint.js";

const EXPECTED_HINTS = {
  "mic-permission-denied": "Grant microphone access in setup.",
  "vad-rejected": "Speak closer to the microphone.",
  "blank-result": "Try again in a quieter place.",
  timeout: "The speech model is busy. Try again.",
  "webgpu-failed":
    "The fast model is unavailable. Sotto uses the small model.",
  "nano-unavailable": "Open setup to prepare Gemini Nano.",
  "nano-parse-failure": "Say the command in different words.",
  "capture-permission": "Enable screen capture in setup.",
  "download-failure": "Check the connection, then press Resume.",
  "tts-failure": "Check the sound output.",
  "restricted-page": undefined,
} as const satisfies Record<RecoveryErrorClass, string | undefined>;

describe("error recovery hints", () => {
  it("maps every known class to one short hint or explicit none", () => {
    expect(RECOVERY_ERROR_CLASSES).toEqual(Object.keys(EXPECTED_HINTS));
    for (const errorClass of RECOVERY_ERROR_CLASSES) {
      const hint = recoveryHint(errorClass);
      expect(hint).toBe(EXPECTED_HINTS[errorClass]);
      if (hint) expect(hint.split(/\s+/).length).toBeLessThanOrEqual(10);
    }
  });

  it("returns no hint for a restricted page", () => {
    expect(recoveryHint("restricted-page")).toBeUndefined();
  });
});
