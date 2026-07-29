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
      description: "Access is ready.",
    };
  }
  if (state === "unknown") {
    return {
      id: "microphone",
      state: "pending",
      description: "Checking access.",
    };
  }
  return {
    id: "microphone",
    state: "needs-action",
    description: state === "denied"
      ? "Access is blocked. Review Chrome settings."
      : "Allow access to use voice commands.",
    action: "microphone",
  };
}

function captureRow(state: SetupState["capture"]): SetupRow {
  if (state === true) {
    return {
      id: "capture",
      state: "done",
      description: "The one-time grant is ready.",
    };
  }
  if (state === undefined) {
    return {
      id: "capture",
      state: "pending",
      description: "Checking the one-time grant.",
    };
  }
  return {
    id: "capture",
    state: "needs-action",
    description: "Enable the one-time grant for screen tasks.",
    action: "capture",
  };
}

function nanoRow(state: SetupState["nano"]): SetupRow {
  switch (state) {
    case "available":
      return {
        id: "nano",
        state: "done",
        description: "The local model is ready.",
      };
    case "downloading":
      return {
        id: "nano",
        state: "pending",
        description: "The local model is downloading.",
        action: "nano",
      };
    case "downloadable":
      return {
        id: "nano",
        state: "needs-action",
        description: "Download the local model.",
        action: "nano",
      };
    case "unavailable":
      return {
        id: "nano",
        state: "needs-action",
        description: "The local model is not available on this device.",
      };
    default:
      return {
        id: "nano",
        state: "pending",
        description: "Checking the local model.",
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
      description: "Checking the optional models.",
    };
  }
  const speechReady = speech === "ready" || speech === "active";
  if (voice === "ready" && speechReady) {
    return {
      id: "premium",
      state: "done",
      description: "The optional models are ready.",
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
      description: "An optional model is downloading.",
    };
  }
  return {
    id: "premium",
    state: "needs-action",
    description: "Download optional models for better speech and voice.",
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
