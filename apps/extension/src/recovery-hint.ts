import { t } from "./panel-i18n.js";

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
  "mic-permission-denied": t("hintMicrophonePermission"),
  "vad-rejected": t("hintSpeakCloser"),
  "blank-result": t("hintQuieterPlace"),
  timeout: t("hintSpeechModelBusy"),
  "webgpu-failed": t("hintFastModelUnavailable"),
  "nano-unavailable": t("hintPrepareNano"),
  "nano-parse-failure": t("hintDifferentWords"),
  "capture-permission": t("hintEnableCapture"),
  "download-failure": t("hintDownloadFailure"),
  "tts-failure": t("hintSoundOutput"),
  "restricted-page": undefined,
};

export function recoveryHint(
  errorClass: RecoveryErrorClass,
): string | undefined {
  return RECOVERY_HINTS[errorClass];
}
