export const RECOVERY_ERROR_CLASSES = [
  "mic-permission-denied",
  "vad-rejected",
  "blank-result",
  "timeout",
  "webgpu-failed",
  "nano-unavailable",
  "nano-parse-failure",
  "capture-permission",
  "download-failure",
  "tts-failure",
  "restricted-page",
] as const;

export type RecoveryErrorClass = typeof RECOVERY_ERROR_CLASSES[number];

const RECOVERY_HINTS: Readonly<
  Record<RecoveryErrorClass, string | undefined>
> = {
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
};

export function recoveryHint(
  errorClass: RecoveryErrorClass,
): string | undefined {
  return RECOVERY_HINTS[errorClass];
}
