import { t } from "./panel-i18n.js";

export type NanoSetupState =
  | "unavailable"
  | "downloadable"
  | "downloading"
  | "available";

export type PremiumVoiceSetupState =
  | "absent"
  | "downloading"
  | "ready"
  | "error";

export type PremiumSpeechSetupState =
  | "not-downloaded"
  | "downloading"
  | "validating"
  | "loading"
  | "warming"
  | "ready"
  | "active"
  | "error";

export type SetupRowId =
  | "microphone"
  | "capture"
  | "nano"
  | "premium";

export type SetupRowState = "done" | "pending" | "needs-action";

export type SetupAction =
  | "microphone"
  | "capture"
  | "nano"
  | "premium-voice"
  | "premium-speech";

export interface SetupRow {
  readonly id: SetupRowId;
  readonly state: SetupRowState;
  readonly description: string;
  readonly action?: SetupAction;
}

export interface SetupViewState {
  readonly rows: readonly SetupRow[];
  readonly complete: boolean;
}

interface SetupState {
  readonly microphone: PermissionState | "unknown";
  readonly capture?: boolean | undefined;
  readonly nano?: NanoSetupState | undefined;
  readonly premiumVoice?: PremiumVoiceSetupState | undefined;
  readonly premiumSpeech?: PremiumSpeechSetupState | undefined;
}

function microphoneRow(
  state: SetupState["microphone"],
): SetupRow {
  if (state === "granted") {
    return {
      id: "microphone",
      state: "done",
      description: t("setupAccessReady"),
    };
  }
  if (state === "unknown") {
    return {
      id: "microphone",
      state: "pending",
      description: t("setupCheckingAccess"),
    };
  }
  return {
    id: "microphone",
    state: "needs-action",
    description: state === "denied"
      ? t("setupAccessBlocked")
      : t("setupAllowAccess"),
    action: "microphone",
  };
}

function captureRow(state: SetupState["capture"]): SetupRow {
  if (state === true) {
    return {
      id: "capture",
      state: "done",
      description: t("setupCaptureReady"),
    };
  }
  if (state === undefined) {
    return {
      id: "capture",
      state: "pending",
      description: t("setupCheckingCapture"),
    };
  }
  return {
    id: "capture",
    state: "needs-action",
    description: t("setupEnableCapture"),
    action: "capture",
  };
}

function nanoRow(state: SetupState["nano"]): SetupRow {
  switch (state) {
    case "available":
      return {
        id: "nano",
        state: "done",
        description: t("setupLocalModelReady"),
      };
    case "downloading":
      return {
        id: "nano",
        state: "pending",
        description: t("setupLocalModelDownloading"),
        action: "nano",
      };
    case "downloadable":
      return {
        id: "nano",
        state: "needs-action",
        description: t("setupDownloadLocalModel"),
        action: "nano",
      };
    case "unavailable":
      return {
        id: "nano",
        state: "needs-action",
        description: t("setupLocalModelUnavailable"),
      };
    default:
      return {
        id: "nano",
        state: "pending",
        description: t("setupCheckingLocalModel"),
      };
  }
}

function premiumRow(
  voice: SetupState["premiumVoice"],
  speech: SetupState["premiumSpeech"],
): SetupRow {
  if (voice === undefined || speech === undefined) {
    return {
      id: "premium",
      state: "pending",
      description: t("setupCheckingOptionalModels"),
    };
  }
  const speechReady = speech === "ready" || speech === "active";
  if (voice === "ready" && speechReady) {
    return {
      id: "premium",
      state: "done",
      description: t("setupOptionalModelsReady"),
    };
  }
  if (
    voice === "downloading" ||
    speech === "downloading" ||
    speech === "validating" ||
    speech === "loading" ||
    speech === "warming"
  ) {
    return {
      id: "premium",
      state: "pending",
      description: t("setupOptionalModelDownloading"),
    };
  }
  return {
    id: "premium",
    state: "needs-action",
    description: t("setupDownloadOptionalModels"),
    action: voice === "ready" ? "premium-speech" : "premium-voice",
  };
}

export function deriveSetupViewState(state: SetupState): SetupViewState {
  const rows = [
    microphoneRow(state.microphone),
    captureRow(state.capture),
    nanoRow(state.nano),
    premiumRow(state.premiumVoice, state.premiumSpeech),
  ];
  return {
    rows,
    complete: rows.slice(0, 3).every((row) => row.state === "done"),
  };
}
