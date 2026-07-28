import type {
  ActionResult,
  ClipboardWorkflow,
  ScreenshotPermissionWorkflow,
} from "@sotto/core";
import { performClipboardWorkflow } from "@sotto/destinations";
import { nextLogEntry, type LogEntry } from "./log.js";
import {
  formatExchangeTimings,
  isExchangeTimings,
  type ExchangeTimings,
} from "./timings.js";
import "./styles.css";

type NanoAvailability = "unavailable" | "downloadable" | "downloading" | "available";
type ModelProgressKind =
  | "nano"
  | "stt"
  | "summarizer"
  | "rewriter"
  | "premium-tts"
  | "premium-stt";
type PremiumTtsState = "absent" | "downloading" | "ready" | "error";
type PremiumSttState =
  | "not-downloaded"
  | "downloading"
  | "validating"
  | "loading"
  | "warming"
  | "ready"
  | "active"
  | "error";
type PremiumSttTier = "parakeet" | "moonshine-base";
type SttDiagnostic =
  | "vad-rejected"
  | "blank-result"
  | "timeout"
  | "webgpu-failed";

interface PanelNote {
  readonly id: string;
  readonly body: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(
  value: unknown,
  maximum: number,
  minimum = 0,
): value is string {
  return (
    typeof value === "string" &&
    value.length >= minimum &&
    value.length <= maximum
  );
}

function isPanelNote(value: unknown): value is PanelNote {
  if (!isRecord(value)) return false;
  return (
    isBoundedString(value.id, 128, 1) &&
    isBoundedString(value.body, 10_000, 1) &&
    isBoundedString(value.createdAt, 35, 1) &&
    isBoundedString(value.updatedAt, 35, 1) &&
    Number.isFinite(Date.parse(value.createdAt)) &&
    Number.isFinite(Date.parse(value.updatedAt))
  );
}

type PanelMessage =
  | {
      target: "sidepanel";
      type: "engine-status";
      nano: NanoAvailability;
      listening: boolean;
      mic: PermissionState | "unknown";
      error?: string;
    }
  | { target: "sidepanel"; type: "listening-state"; listening: boolean }
  | { target: "sidepanel"; type: "speech-start" }
  | { target: "sidepanel"; type: "speech-end" }
  | { target: "sidepanel"; type: "mic-level"; level: number }
  | { target: "sidepanel"; type: "transcript"; text: string }
  | {
      target: "sidepanel";
      type: "model-progress";
      model: ModelProgressKind;
      progress: number;
      status?: string;
      file?: string;
      loaded?: number;
      total?: number;
    }
  | { target: "sidepanel"; type: "earcon"; kind: "listen" | "complete" }
  | {
      target: "sidepanel";
      type: "action-log";
      heard: string;
      did: string;
      timings?: ExchangeTimings;
    }
  | {
      target: "sidepanel";
      type: "screenshot-ready";
      workflow: ClipboardWorkflow;
    }
  | {
      target: "sidepanel";
      type: "screenshot-permission-needed";
      workflow: ScreenshotPermissionWorkflow;
    }
  | {
      target: "sidepanel";
      type: "page-text";
      text: string;
      title?: string;
    }
  | { target: "sidepanel"; type: "rewrite-fallback"; text: string }
  | {
      target: "sidepanel";
      type: "reading-progress";
      current: number;
      total: number;
    }
  | {
      target: "sidepanel";
      type: "notes-updated";
      notes: readonly PanelNote[];
    }
  | {
      target: "sidepanel";
      type: "reminder-fired" | "reminder-opened";
      reminder: {
        readonly id: string;
        readonly text: string;
        readonly dueAt: string;
        readonly notificationPermission?: string;
      };
    }
  | { target: "sidepanel"; type: "pipeline-error"; message: string }
  | {
      target: "sidepanel";
      type: "premium-tts-state";
      state: PremiumTtsState;
      enabled: boolean;
      backend?: "webgpu" | "wasm";
      error?: string;
    }
  | {
      target: "sidepanel";
      type: "premium-stt-state";
      state: PremiumSttState;
      enabled: boolean;
      downloaded: boolean;
      resident: boolean;
      resumable?: boolean;
      tier: PremiumSttTier;
      backend: "webgpu" | "wasm";
      error?: string;
    }
  | {
      target: "sidepanel";
      type: "stt-diagnostic";
      diagnostic: SttDiagnostic;
      message: string;
    };

function validatesV02PanelPayload(message: Record<string, unknown>): boolean {
  switch (message.type) {
    case "action-log":
      return (
        isBoundedString(message.heard, 2_000, 1) &&
        isBoundedString(message.did, 2_000, 1) &&
        (message.timings === undefined ||
          isExchangeTimings(message.timings))
      );
    case "screenshot-permission-needed": {
      if (!isRecord(message.workflow)) return false;
      const workflow = message.workflow;
      if (
        !Object.keys(workflow).every((key) =>
          ["kind", "originPattern", "host", "pendingCommand"].includes(key)
        ) ||
        workflow.kind !== "screenshot-permission" ||
        workflow.originPattern !== "<all_urls>" ||
        !isBoundedString(workflow.host, 300, 1) ||
        !isRecord(workflow.pendingCommand)
      ) {
        return false;
      }
      const command = workflow.pendingCommand;
      return (
        Object.keys(command).length === 2 &&
        command.action === "screenshot" &&
        (command.destination === "copy" ||
          command.destination === "claude")
      );
    }
    case "page-text":
      return (
        isBoundedString(message.text, 120_000, 1) &&
        (message.title === undefined ||
          isBoundedString(message.title, 600))
      );
    case "rewrite-fallback":
      return isBoundedString(message.text, 24_000, 1);
    case "reading-progress":
      return (
        typeof message.current === "number" &&
        Number.isFinite(message.current) &&
        message.current >= 0 &&
        typeof message.total === "number" &&
        Number.isFinite(message.total) &&
        message.total > 0 &&
        message.current <= message.total
      );
    case "notes-updated":
      return (
        Array.isArray(message.notes) &&
        message.notes.length <= 5_000 &&
        message.notes.every(isPanelNote)
      );
    case "reminder-fired":
    case "reminder-opened": {
      if (!isRecord(message.reminder)) return false;
      return (
        isBoundedString(message.reminder.id, 128, 1) &&
        isBoundedString(message.reminder.text, 1_000, 1) &&
        isBoundedString(message.reminder.dueAt, 35, 1) &&
        Number.isFinite(Date.parse(message.reminder.dueAt)) &&
        (message.reminder.notificationPermission === undefined ||
          message.reminder.notificationPermission === "granted" ||
          message.reminder.notificationPermission === "denied")
      );
    }
    case "model-progress":
      return (
        (message.model === "nano" ||
          message.model === "stt" ||
          message.model === "summarizer" ||
          message.model === "rewriter" ||
          message.model === "premium-tts" ||
          message.model === "premium-stt") &&
        typeof message.progress === "number" &&
        Number.isFinite(message.progress) &&
        message.progress >= 0 &&
        message.progress <= 1 &&
        (message.status === undefined ||
          isBoundedString(message.status, 100)) &&
        (message.file === undefined ||
          isBoundedString(message.file, 1_000)) &&
        (message.loaded === undefined ||
          (typeof message.loaded === "number" &&
            Number.isFinite(message.loaded) &&
            message.loaded >= 0)) &&
        (message.total === undefined ||
          (typeof message.total === "number" &&
            Number.isFinite(message.total) &&
            message.total > 0)) &&
        (
          message.loaded === undefined ||
          message.total === undefined ||
          message.loaded <= message.total
        )
      );
    case "premium-tts-state":
      return (
        (message.state === "absent" ||
          message.state === "downloading" ||
          message.state === "ready" ||
          message.state === "error") &&
        typeof message.enabled === "boolean" &&
        (message.backend === undefined ||
          message.backend === "webgpu" ||
          message.backend === "wasm") &&
        (message.error === undefined ||
          isBoundedString(message.error, 1_000))
      );
    case "premium-stt-state":
      return (
        (message.state === "not-downloaded" ||
          message.state === "downloading" ||
          message.state === "validating" ||
          message.state === "loading" ||
          message.state === "warming" ||
          message.state === "ready" ||
          message.state === "active" ||
          message.state === "error") &&
        typeof message.enabled === "boolean" &&
        typeof message.downloaded === "boolean" &&
        typeof message.resident === "boolean" &&
        (message.resumable === undefined ||
          typeof message.resumable === "boolean") &&
        (message.tier === "parakeet" ||
          message.tier === "moonshine-base") &&
        (message.backend === "webgpu" ||
          message.backend === "wasm") &&
        (message.error === undefined ||
          isBoundedString(message.error, 1_000))
      );
    case "stt-diagnostic":
      return (
        (message.diagnostic === "vad-rejected" ||
          message.diagnostic === "blank-result" ||
          message.diagnostic === "timeout" ||
          message.diagnostic === "webgpu-failed") &&
        isBoundedString(message.message, 1_000, 1)
      );
    case "mic-level":
      return (
        typeof message.level === "number" &&
        Number.isFinite(message.level) &&
        message.level >= 0 &&
        message.level <= 1
      );
    default:
      return true;
  }
}

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing UI element: ${selector}`);
  return element;
}

const statusChip = requiredElement<HTMLElement>("#status-chip");
const statusLabel = requiredElement<HTMLElement>("#status-label");
const pipelineError = requiredElement<HTMLElement>("#pipeline-error");
const captureSetup = requiredElement<HTMLElement>("#capture-setup");
const enableCapture = requiredElement<HTMLButtonElement>("#enable-capture");
const setupGrantMic = requiredElement<HTMLButtonElement>("#setup-grant-mic");
const setupPrepareNano = requiredElement<HTMLButtonElement>("#setup-prepare-nano");
const onboarding = requiredElement<HTMLElement>("#onboarding");
const onboardingTitle = requiredElement<HTMLElement>("#onboarding-title");
const onboardingCopy = requiredElement<HTMLElement>("#onboarding-copy");
const prepareNano = requiredElement<HTMLButtonElement>("#prepare-nano");
const transcript = requiredElement<HTMLElement>("#transcript");
const listeningMark = requiredElement<HTMLElement>("#listening-mark");
const listenButton = requiredElement<HTMLButtonElement>("#listen-button");
const listenLabel = requiredElement<HTMLElement>("#listen-label");
const micMeter = requiredElement<HTMLElement>("#mic-meter");
const micMeterFill = requiredElement<HTMLElement>("#mic-meter-fill");
const shortcutLabel = requiredElement<HTMLElement>("#shortcut-label");
const grantMic = requiredElement<HTMLButtonElement>("#grant-mic");
const commandForm = requiredElement<HTMLFormElement>("#command-form");
const commandInput = requiredElement<HTMLInputElement>("#command-input");
const clipboardCard = requiredElement<HTMLElement>("#clipboard-card");
const clipboardCopy = requiredElement<HTMLElement>("#clipboard-copy");
const copyScreenshot = requiredElement<HTMLButtonElement>("#copy-screenshot");
const actionLog = requiredElement<HTMLOListElement>("#action-log");
const actionLogAnnouncer =
  requiredElement<HTMLElement>("#action-log-announcer");
const clearLog = requiredElement<HTMLButtonElement>("#clear-log");
const nanoProgressCard = requiredElement<HTMLElement>("#nano-progress-card");
const nanoProgress = requiredElement<HTMLProgressElement>("#nano-progress");
const nanoProgressValue = requiredElement<HTMLOutputElement>("#nano-progress-value");
const nanoProgressLabel = requiredElement<HTMLElement>("#nano-progress-label");
const sttProgressCard = requiredElement<HTMLElement>("#stt-progress-card");
const sttProgress = requiredElement<HTMLProgressElement>("#stt-progress");
const sttProgressValue = requiredElement<HTMLOutputElement>("#stt-progress-value");
const premiumVoiceCard = requiredElement<HTMLElement>("#premium-voice-card");
const premiumVoiceState = requiredElement<HTMLElement>("#premium-voice-state");
const premiumVoiceCopy = requiredElement<HTMLElement>("#premium-voice-copy");
const downloadPremiumVoice =
  requiredElement<HTMLButtonElement>("#download-premium-voice");
const premiumVoiceEnabled =
  requiredElement<HTMLInputElement>("#premium-voice-enabled");
const premiumProgressCard =
  requiredElement<HTMLElement>("#premium-progress-card");
const premiumProgress =
  requiredElement<HTMLProgressElement>("#premium-progress");
const premiumProgressValue =
  requiredElement<HTMLOutputElement>("#premium-progress-value");
const premiumProgressLabel =
  requiredElement<HTMLElement>("#premium-progress-label");
const premiumSttCard =
  requiredElement<HTMLElement>("#premium-stt-card");
const premiumSttState =
  requiredElement<HTMLElement>("#premium-stt-state");
const premiumSttCopy =
  requiredElement<HTMLElement>("#premium-stt-copy");
const downloadPremiumStt =
  requiredElement<HTMLButtonElement>("#download-premium-stt");
const premiumSttEnabled =
  requiredElement<HTMLInputElement>("#premium-stt-enabled");
const premiumSttProgressCard =
  requiredElement<HTMLElement>("#premium-stt-progress-card");
const premiumSttProgress =
  requiredElement<HTMLProgressElement>("#premium-stt-progress");
const premiumSttProgressValue =
  requiredElement<HTMLOutputElement>("#premium-stt-progress-value");
const premiumSttProgressLabel =
  requiredElement<HTMLElement>("#premium-stt-progress-label");
const pageTextCard = requiredElement<HTMLElement>("#page-text-card");
const pageTextTitle = requiredElement<HTMLElement>("#page-text-title");
const pageTextOutput = requiredElement<HTMLElement>("#page-text-output");
const closePageText = requiredElement<HTMLButtonElement>("#close-page-text");
const readingProgress = requiredElement<HTMLProgressElement>("#reading-progress");
const notesList = requiredElement<HTMLUListElement>("#notes-list");
const exportNotes = requiredElement<HTMLButtonElement>("#export-notes");
const reminderBanner = requiredElement<HTMLElement>("#reminder-banner");

let isListening = false;
let pendingScreenshot: ClipboardWorkflow | undefined;
let pendingScreenshotPermission: ScreenshotPermissionWorkflow | undefined;
let newestLogEntry: LogEntry | undefined;
let pointerIsDown = false;
let earconContext: AudioContext | undefined;
let capturePermissionGranted: boolean | undefined;
let nanoAvailability: NanoAvailability | undefined;
let premiumState: PremiumTtsState = "absent";
let highAccuracyState: PremiumSttState = "not-downloaded";
let highAccuracyTier: PremiumSttTier = "moonshine-base";
let highAccuracyResumable = false;
let meterAccessibleTimer: number | undefined;
let pendingMeterAccessibleValue: number | undefined;
let lastMeterAccessibleUpdate = Number.NEGATIVE_INFINITY;
const progressHideTimers:
  Partial<Record<"nano" | "stt" | "premium-tts" | "premium-stt", number>> = {};
const METER_ACCESSIBLE_INTERVAL_MS = 500;

function setStatus(
  state: "booting" | "ready" | "listening" | "error",
  label: string,
): void {
  statusChip.dataset.state = state;
  statusLabel.textContent = label;
}

function setListening(listening: boolean): void {
  isListening = listening;
  listenButton.setAttribute("aria-pressed", String(listening));
  listenLabel.textContent = listening ? "Listening…" : "Hold to talk";
  listeningMark.textContent = listening ? "LIVE" : "IDLE";
  listeningMark.dataset.active = String(listening);
  micMeter.dataset.state = listening ? "listening" : "idle";
  if (!listening) {
    micMeterFill.style.transform = "scaleX(0)";
    updateMeterAccessibleValue(0);
  }
  setStatus(listening ? "listening" : "ready", listening ? "Listening" : "On device");
}

function commitMeterAccessibleValue(value: number): void {
  micMeter.setAttribute("aria-valuenow", String(value));
  lastMeterAccessibleUpdate = Date.now();
  pendingMeterAccessibleValue = undefined;
  meterAccessibleTimer = undefined;
}

function updateMeterAccessibleValue(level: number): void {
  pendingMeterAccessibleValue = Math.round(level * 100);
  const remaining =
    METER_ACCESSIBLE_INTERVAL_MS - (Date.now() - lastMeterAccessibleUpdate);
  if (remaining <= 0) {
    if (meterAccessibleTimer !== undefined) {
      window.clearTimeout(meterAccessibleTimer);
      meterAccessibleTimer = undefined;
    }
    commitMeterAccessibleValue(pendingMeterAccessibleValue);
    return;
  }
  if (meterAccessibleTimer !== undefined) return;
  meterAccessibleTimer = window.setTimeout(() => {
    if (pendingMeterAccessibleValue !== undefined) {
      commitMeterAccessibleValue(pendingMeterAccessibleValue);
    }
  }, remaining);
}

function showMicLevel(level: number): void {
  if (!isListening) return;
  micMeterFill.style.transform = `scaleX(${level})`;
  updateMeterAccessibleValue(level);
}

function showTranscript(text: string): void {
  transcript.textContent = text || "Your words will appear here.";
  transcript.dataset.placeholder = String(!text);
}

function showNanoState(availability: NanoAvailability): void {
  nanoAvailability = availability;
  setupPrepareNano.hidden =
    availability !== "downloadable" && availability !== "downloading";
  setupPrepareNano.textContent =
    availability === "downloading" ? "Continue model setup" : "Prepare Gemini Nano";

  if (capturePermissionGranted === false) {
    onboarding.hidden = true;
    return;
  }

  if (availability === "unavailable") {
    onboarding.hidden = false;
    onboardingTitle.textContent = "Nano is unavailable here.";
    onboardingCopy.textContent =
      "Sotto will not send commands to a server. Check the local hardware requirements below, Chrome policy, and available storage.";
    prepareNano.hidden = true;
    setStatus("error", "Nano unavailable");
    return;
  }

  if (availability === "downloadable" || availability === "downloading") {
    onboarding.hidden = false;
    onboardingTitle.textContent = "One local model to prepare.";
    onboardingCopy.textContent =
      "Chrome can download Gemini Nano after a click. It stays on this device and is shared with Chrome’s built-in AI features.";
    prepareNano.hidden = false;
    prepareNano.textContent =
      availability === "downloading" ? "Continue model setup" : "Prepare Gemini Nano";
    setStatus("booting", availability === "downloading" ? "Nano downloading" : "Nano setup");
    return;
  }

  onboarding.hidden = true;
  prepareNano.hidden = true;
  setStatus(isListening ? "listening" : "ready", isListening ? "Listening" : "On device");
}

function showMicrophoneState(state: PermissionState | "unknown"): void {
  const granted = state === "granted";
  listenButton.disabled = !granted;
  const label =
    state === "denied"
      ? "Review microphone settings"
      : "Grant microphone access";
  grantMic.textContent = label;
  setupGrantMic.textContent = granted ? "Microphone enabled" : label;
  setupGrantMic.disabled = granted;
  if (granted) return;

  listenLabel.textContent = "Use text command";
  setStatus(
    state === "denied" ? "error" : "booting",
    state === "denied" ? "Microphone blocked" : "Microphone setup",
  );
}

function showCapturePermissionState(granted: boolean): void {
  capturePermissionGranted = granted;
  captureSetup.hidden = granted;
  if (nanoAvailability) showNanoState(nanoAvailability);
}

async function requestCapturePermission(): Promise<boolean> {
  const granted = await chrome.permissions
    .request({ origins: ["<all_urls>"] })
    .catch((error: unknown) => {
      console.warn("Sotto screenshot permission request failed", error);
      return false;
    });
  showCapturePermissionState(granted);
  return granted;
}

async function loadCapturePermissionState(): Promise<void> {
  try {
    showCapturePermissionState(
      await chrome.permissions.contains({ origins: ["<all_urls>"] }),
    );
  } catch (error) {
    console.warn("Sotto could not check screenshot permission", error);
    showCapturePermissionState(false);
  }
}

async function playEarcon(kind: "listen" | "complete"): Promise<void> {
  try {
    earconContext ??= new AudioContext();
    if (earconContext.state === "suspended") await earconContext.resume();

    const now = earconContext.currentTime;
    const oscillator = earconContext.createOscillator();
    const gain = earconContext.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(kind === "listen" ? 660 : 880, now);
    if (kind === "complete") {
      oscillator.frequency.exponentialRampToValueAtTime(1_140, now + 0.07);
    }
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.09, now + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.095);
    oscillator.connect(gain).connect(earconContext.destination);
    oscillator.start(now);
    oscillator.stop(now + 0.105);
  } catch (error) {
    console.warn("Sotto earcon could not play", error);
  }
}

function updateProgress(
  model: ModelProgressKind,
  value: number,
  complete = value >= 1,
  file?: string,
  loaded?: number,
  total?: number,
): void {
  const normalized = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  const progressKind =
    model === "stt"
      ? "stt"
      : model === "premium-tts"
        ? "premium-tts"
        : model === "premium-stt"
          ? "premium-stt"
          : "nano";
  const card =
    progressKind === "nano"
      ? nanoProgressCard
      : progressKind === "stt"
        ? sttProgressCard
        : progressKind === "premium-tts"
          ? premiumProgressCard
          : premiumSttProgressCard;
  const bar =
    progressKind === "nano"
      ? nanoProgress
      : progressKind === "stt"
        ? sttProgress
        : progressKind === "premium-tts"
          ? premiumProgress
          : premiumSttProgress;
  const output = progressKind === "nano"
    ? nanoProgressValue
    : progressKind === "stt"
      ? sttProgressValue
      : progressKind === "premium-tts"
        ? premiumProgressValue
        : premiumSttProgressValue;
  if (progressKind === "nano") {
    nanoProgressLabel.textContent =
      model === "summarizer"
        ? "Chrome Summarizer"
        : model === "rewriter"
          ? "Chrome Rewriter"
          : "Gemini Nano";
  }
  if (progressKind === "premium-tts") {
    premiumProgressLabel.textContent = file
      ? `Kokoro · ${file.split("/").at(-1) ?? "model"}`
      : "Kokoro voice model";
  }
  if (progressKind === "premium-stt") {
    premiumSttProgressLabel.textContent = file
      ? `Speech · ${file.split("/").at(-1) ?? "model"}`
      : "High accuracy speech model";
  }
  card.hidden = false;
  if (file) card.title = file;
  bar.value = normalized;
  output.value =
    typeof loaded === "number" &&
      Number.isFinite(loaded) &&
      typeof total === "number" &&
      Number.isFinite(total) &&
      total > 0
      ? `${formatMegabytes(loaded)} of ${formatMegabytes(total)} MB`
      : `${Math.round(normalized * 100)}%`;
  output.textContent = output.value;
  const previousTimer = progressHideTimers[progressKind];
  if (previousTimer !== undefined) {
    window.clearTimeout(previousTimer);
    delete progressHideTimers[progressKind];
  }
  if (complete) {
    progressHideTimers[progressKind] = window.setTimeout(() => {
      card.hidden = true;
      delete progressHideTimers[progressKind];
    }, 900);
  }
}

function formatMegabytes(bytes: number): string {
  const value = bytes / 1_000_000;
  if (value >= 10) return String(Math.round(value));
  return value.toFixed(1).replace(/\.0$/, "");
}

function showPremiumVoiceState(
  state: PremiumTtsState,
  enabled: boolean,
  backend?: "webgpu" | "wasm",
  error?: string,
): void {
  premiumState = state;
  premiumVoiceCard.dataset.state = state;
  premiumVoiceState.textContent = state.toUpperCase();
  premiumVoiceEnabled.checked = enabled;
  premiumVoiceEnabled.disabled = state !== "ready";
  downloadPremiumVoice.hidden = state === "ready";
  downloadPremiumVoice.disabled = state === "downloading";

  switch (state) {
    case "absent":
      downloadPremiumVoice.textContent = "Download premium voice";
      premiumVoiceCopy.textContent =
        "Download the natural on-device voice when you are ready. Until then, Sotto uses your operating system voice instantly.";
      break;
    case "downloading":
      downloadPremiumVoice.hidden = false;
      downloadPremiumVoice.textContent = "Downloading on device…";
      premiumProgressCard.hidden = false;
      premiumVoiceCopy.textContent =
        "Sotto stays responsive while the model downloads. Spoken feedback continues through your operating system voice.";
      break;
    case "ready":
      premiumVoiceCopy.textContent =
        `Kokoro af_heart is ready at 24 kHz${backend ? ` via ${backend.toUpperCase()}` : ""}. Your operating system voice remains the instant fallback.`;
      break;
    case "error":
      downloadPremiumVoice.textContent = "Retry voice download";
      premiumVoiceCopy.textContent =
        error ??
        "The voice download failed. Select retry to use completed files from the local cache.";
      break;
  }
}

function showPremiumSttState(
  state: PremiumSttState,
  enabled: boolean,
  downloaded: boolean,
  resident: boolean,
  tier: PremiumSttTier,
  resumable = false,
  error?: string,
): void {
  highAccuracyState = state;
  highAccuracyTier = tier;
  highAccuracyResumable = resumable;
  premiumSttCard.dataset.state = state;
  premiumSttState.textContent = state.replace("-", " ").toUpperCase();
  premiumSttEnabled.checked = enabled;
  premiumSttEnabled.disabled = !downloaded ||
    (state !== "ready" && state !== "active");
  const busy =
    state === "downloading" ||
    state === "validating" ||
    state === "loading" ||
    state === "warming";
  downloadPremiumStt.disabled = busy;
  downloadPremiumStt.hidden = state === "ready" || state === "active";
  const modelCopy = tier === "parakeet"
    ? "Parakeet-TDT v3 uses a 409 MB pinned model with a WebGPU encoder."
    : "This machine uses Moonshine base q8, a 63 MB WASM accuracy upgrade.";

  switch (state) {
    case "not-downloaded":
      downloadPremiumStt.hidden = false;
      downloadPremiumStt.disabled = false;
      downloadPremiumStt.textContent = resumable
        ? "Resume download"
        : tier === "parakeet"
          ? "Download 409 MB model"
          : "Download 63 MB model";
      premiumSttCopy.textContent =
        `${modelCopy} Nothing downloads until you choose it; Moonshine tiny remains instant.`;
      break;
    case "downloading":
      downloadPremiumStt.hidden = false;
      downloadPremiumStt.textContent = "Downloading on device…";
      premiumSttProgressCard.hidden = false;
      premiumSttCopy.textContent =
        `${modelCopy} The files are validated before activation.`;
      break;
    case "validating":
      downloadPremiumStt.hidden = false;
      downloadPremiumStt.textContent = "Validating pinned files…";
      premiumSttProgressCard.hidden = false;
      premiumSttCopy.textContent =
        "Sotto is checking the complete local model before loading it.";
      break;
    case "loading":
      downloadPremiumStt.hidden = false;
      downloadPremiumStt.textContent = "Loading local model…";
      premiumSttCopy.textContent =
        "The model is compiling locally. Moonshine tiny stays available until validation finishes.";
      break;
    case "warming":
      downloadPremiumStt.hidden = false;
      downloadPremiumStt.textContent = "Running hardware check…";
      premiumSttCopy.textContent =
        "A bundled spoken-word fixture is checking recognition and warm latency.";
      break;
    case "ready":
      premiumSttCopy.textContent =
        `${modelCopy} It is ready but switched off; Moonshine tiny is active.`;
      break;
    case "active":
      premiumSttCopy.textContent =
        `${modelCopy} High accuracy is ON${resident ? "" : " and will reload from the local cache when needed"}.`;
      break;
    case "error":
      downloadPremiumStt.hidden = false;
      downloadPremiumStt.disabled = false;
      downloadPremiumStt.textContent = resumable
        ? "Resume download"
        : "Retry high accuracy setup";
      premiumSttCopy.textContent =
        resumable
          ? "The download stopped. Select resume after the network is available."
          : error ??
            "High accuracy speech could not start. Moonshine tiny remains active.";
      break;
  }
}

function showPageText(text: string, title: string): void {
  pageTextTitle.textContent = title;
  pageTextOutput.textContent = text;
  pageTextCard.hidden = false;
}

function renderNotes(notes: readonly PanelNote[]): void {
  notesList.replaceChildren();
  if (notes.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty-notes";
    empty.textContent = "No notes yet.";
    notesList.append(empty);
    exportNotes.disabled = true;
    return;
  }
  exportNotes.disabled = false;
  for (const note of notes) {
    const item = document.createElement("li");
    const body = document.createElement("p");
    const time = document.createElement("time");
    body.textContent = note.body;
    const created = new Date(note.createdAt);
    time.dateTime = note.createdAt;
    time.textContent = Number.isNaN(created.getTime())
      ? "Saved note"
      : created.toLocaleString([], {
          dateStyle: "medium",
          timeStyle: "short",
        });
    item.append(body, time);
    notesList.append(item);
  }
}

function showReminder(
  reminder: {
    readonly text: string;
    readonly notificationPermission?: string;
  },
  notificationDenied = false,
): void {
  reminderBanner.textContent =
    notificationDenied && reminder.notificationPermission === "denied"
      ? `Reminder: ${reminder.text} — desktop notifications are disabled.`
      : `Reminder: ${reminder.text}`;
  reminderBanner.hidden = false;
}

function updateLogTime(time: HTMLTimeElement, now: Date): void {
  time.dateTime = now.toISOString();
  time.textContent = now.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function createTimingLine(
  timings: ExchangeTimings | undefined,
): HTMLParagraphElement | undefined {
  if (!timings) return undefined;
  const display = formatExchangeTimings(timings);
  if (!display) return undefined;

  const line = document.createElement("p");
  const total = document.createElement("span");
  line.className = "log-timing";
  line.dataset.tone = display.tone;
  total.className = "log-timing-total";
  total.textContent = display.total;
  line.append(
    document.createTextNode(`${display.stages} · `),
    total,
  );
  return line;
}

function actionLogAnnouncement(heard: string, did: string): string {
  const heardText = /[.!?]$/.test(heard) ? heard : `${heard}.`;
  const didText = /[.!?]$/.test(did) ? did : `${did}.`;
  return `${heardText} ${didText}`;
}

function appendLog(
  heard: string,
  did: string,
  timings?: ExchangeTimings,
  announce = true,
): void {
  const decision = nextLogEntry(newestLogEntry, heard, did);
  const now = new Date();
  const timingLine = createTimingLine(timings);
  if (decision.collapsed) {
    const newest = actionLog.firstElementChild;
    const time = newest?.querySelector<HTMLTimeElement>("time");
    const count = newest?.querySelector<HTMLElement>(".log-count");
    if (time && count) {
      updateLogTime(time, now);
      count.hidden = false;
      count.textContent = `×${decision.entry.count}`;
      newest?.querySelector(".log-timing")?.remove();
      if (timingLine) newest?.append(timingLine);
      newestLogEntry = decision.entry;
      if (announce) {
        actionLogAnnouncer.textContent =
          `${actionLogAnnouncement(heard, did)} Repeated ${decision.entry.count} times.`;
      }
      return;
    }
  }

  actionLog.querySelector(".empty-log")?.remove();
  const item = document.createElement("li");
  const time = document.createElement("time");
  const copy = document.createElement("p");
  const heardText = document.createElement("strong");
  const count = document.createElement("span");
  updateLogTime(time, now);
  heardText.textContent = heard;
  count.className = "log-count";
  count.hidden = true;
  copy.append(
    heardText,
    document.createTextNode(` → ${did}`),
    count,
  );
  item.append(time, copy);
  if (timingLine) item.append(timingLine);
  actionLog.prepend(item);
  newestLogEntry = decision.entry;
  if (announce) {
    actionLogAnnouncer.textContent = actionLogAnnouncement(heard, did);
  }
}

async function requestWorker<T>(
  message: Record<string, unknown>,
): Promise<T | undefined> {
  const response = (await chrome.runtime.sendMessage({
    target: "worker",
    ...message,
  })) as
    | {
        readonly ok: boolean;
        readonly value?: T;
        readonly error?: { readonly message?: string };
      }
    | undefined;
  if (response?.ok === false) {
    throw new Error(response.error?.message ?? "Extension request failed");
  }
  return response?.value;
}

async function send(message: Record<string, unknown>): Promise<boolean> {
  try {
    await requestWorker(message);
    return true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Extension worker unavailable";
    setStatus("error", "Needs attention");
    appendLog("system", detail);
    return false;
  }
}

async function startListening(): Promise<void> {
  if (isListening) return;
  setListening(true);
  if (!(await send({ type: "start-listening" }))) {
    setListening(false);
    setStatus("error", "Needs attention");
  }
}

async function stopListening(): Promise<void> {
  if (!isListening) return;
  setListening(false);
  if (!(await send({ type: "stop-listening" }))) {
    setListening(true);
    setStatus("error", "Needs attention");
  }
}

listenButton.addEventListener("pointerdown", (event) => {
  pointerIsDown = true;
  listenButton.setPointerCapture(event.pointerId);
  void startListening();
});

listenButton.addEventListener("pointerup", (event) => {
  pointerIsDown = false;
  listenButton.releasePointerCapture(event.pointerId);
  void stopListening();
});

listenButton.addEventListener("pointercancel", () => {
  pointerIsDown = false;
  void stopListening();
});

listenButton.addEventListener("keydown", (event) => {
  if ((event.key === " " || event.key === "Enter") && !event.repeat && !pointerIsDown) {
    event.preventDefault();
    void startListening();
  }
});

listenButton.addEventListener("keyup", (event) => {
  if (event.key === " " || event.key === "Enter") {
    event.preventDefault();
    void stopListening();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !document.hasFocus()) return;
  event.preventDefault();
  if (isListening) void stopListening();
  readingProgress.hidden = true;
  void send({ type: "stop-reading" });
});

for (const button of [grantMic, setupGrantMic]) {
  button.addEventListener("click", () => {
    void send({ type: "open-microphone-page" });
  });
}

commandForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = commandInput.value.trim();
  if (!text) return;
  showTranscript(text);
  commandInput.value = "";
  void send({ type: "text-command", text });
});

clearLog.addEventListener("click", () => {
  actionLog.replaceChildren();
  newestLogEntry = undefined;
  const empty = document.createElement("li");
  empty.className = "empty-log";
  empty.textContent = "No commands yet.";
  actionLog.append(empty);
});

closePageText.addEventListener("click", () => {
  pageTextCard.hidden = true;
  readingProgress.hidden = true;
});

exportNotes.addEventListener("click", async () => {
  exportNotes.disabled = true;
  try {
    const result = await requestWorker<{
      readonly filename: string;
      readonly dataUrl: string;
    }>({ type: "export-notes" });
    if (
      !result ||
      !/^sotto-notes-\d{4}-\d{2}-\d{2}\.md$/.test(result.filename) ||
      !result.dataUrl.startsWith("data:text/markdown;charset=utf-8,") ||
      result.dataUrl.length > 2_500_000
    ) {
      throw new Error("Notes export returned invalid data");
    }
    const link = document.createElement("a");
    link.href = result.dataUrl;
    link.download = result.filename;
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
  } catch (error) {
    appendLog(
      "export notes",
      error instanceof Error ? error.message : "Export failed",
    );
  } finally {
    exportNotes.disabled = notesList.querySelector(".empty-notes") !== null;
  }
});

async function prepareNanoModel(): Promise<void> {
  prepareNano.disabled = true;
  setupPrepareNano.disabled = true;
  nanoProgressCard.hidden = false;
  setStatus("booting", "Preparing Nano");

  try {
    if (!("LanguageModel" in globalThis)) {
      throw new Error("Chrome Prompt API is absent");
    }

    const session = await LanguageModel.create({
      initialPrompts: [
        {
          role: "system",
          content: "Initialize the local model for Sotto. Reply briefly.",
        },
      ],
      monitor(monitor) {
        monitor.addEventListener("downloadprogress", (event) => {
          updateProgress("nano", event.loaded);
        });
      },
    });
    session.destroy();
    updateProgress("nano", 1);
    showNanoState("available");
    await send({ type: "nano-ready" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Nano setup failed";
    setStatus("error", "Nano setup failed");
    appendLog("model setup", message);
    prepareNano.disabled = false;
    setupPrepareNano.disabled = false;
  }
}

prepareNano.addEventListener("click", () => void prepareNanoModel());
setupPrepareNano.addEventListener("click", () => void prepareNanoModel());

downloadPremiumVoice.addEventListener("click", async () => {
  showPremiumVoiceState("downloading", true);
  updateProgress("premium-tts", 0, false);
  if (!(await send({ type: "prepare-premium-tts" }))) {
    showPremiumVoiceState(
      "error",
      false,
      undefined,
      "Premium voice setup could not start. Sotto is still using your operating system voice.",
    );
  }
});

premiumVoiceEnabled.addEventListener("change", async () => {
  if (premiumState !== "ready") return;
  const requested = premiumVoiceEnabled.checked;
  premiumVoiceEnabled.disabled = true;
  if (
    !(await send({
      type: "set-premium-tts-enabled",
      enabled: requested,
    }))
  ) {
    premiumVoiceEnabled.checked = !requested;
  }
  premiumVoiceEnabled.disabled = false;
});

downloadPremiumStt.addEventListener("click", async () => {
  downloadPremiumStt.disabled = true;
  if (highAccuracyResumable) {
    premiumSttProgressCard.hidden = false;
  } else {
    updateProgress("premium-stt", 0, false);
  }
  if (!(await send({ type: "prepare-premium-stt" }))) {
    showPremiumSttState(
      "error",
      false,
      false,
      false,
      highAccuracyTier,
      highAccuracyResumable,
      "High accuracy speech setup could not start. Moonshine tiny is still available.",
    );
  }
});

premiumSttEnabled.addEventListener("change", async () => {
  if (highAccuracyState !== "ready" && highAccuracyState !== "active") {
    return;
  }
  const requested = premiumSttEnabled.checked;
  premiumSttEnabled.disabled = true;
  if (
    !(await send({
      type: "set-premium-stt-enabled",
      enabled: requested,
    }))
  ) {
    premiumSttEnabled.checked = !requested;
  }
  premiumSttEnabled.disabled = false;
});

enableCapture.addEventListener("click", async () => {
  enableCapture.disabled = true;
  try {
    if (!(await requestCapturePermission())) {
      appendLog("screen capture", "Permission was not granted");
    }
  } finally {
    enableCapture.disabled = false;
  }
});

function showClipboardWorkflow(workflow: ClipboardWorkflow): void {
  pendingScreenshot = workflow;
  copyScreenshot.textContent = workflow.buttonLabel;
  clipboardCopy.textContent = workflow.afterWrite?.followUp
    ? "Copy the PNG, then Sotto will move you to Claude."
    : "Copy the PNG to your clipboard.";
  clipboardCard.hidden = false;
}

async function completeClipboardWorkflow(
  workflow: ClipboardWorkflow,
): Promise<void> {
  const completion = await performClipboardWorkflow(workflow);
  if (await send({ type: "clipboard-complete", completion })) {
    pendingScreenshot = undefined;
    pendingScreenshotPermission = undefined;
    clipboardCard.hidden = true;
  }
}

async function receiveClipboardWorkflow(
  workflow: ClipboardWorkflow,
): Promise<void> {
  pendingScreenshot = workflow;
  pendingScreenshotPermission = undefined;
  clipboardCard.hidden = true;

  try {
    await completeClipboardWorkflow(workflow);
  } catch {
    showClipboardWorkflow(workflow);
    const message =
      "Chrome blocks clipboard writes while Sotto and the page are both unfocused — click Copy.";
    clipboardCopy.textContent = message;
    appendLog("copy screenshot", message);
  }
}

copyScreenshot.addEventListener("click", async () => {
  const permissionWorkflow = pendingScreenshotPermission;
  const clipboardWorkflow = pendingScreenshot;
  if (!permissionWorkflow && !clipboardWorkflow) return;
  copyScreenshot.disabled = true;

  try {
    if (permissionWorkflow) {
      const granted = await requestCapturePermission();
      if (!granted) {
        const spoken = "Screenshot needs screen capture permission.";
        appendLog("screenshot", spoken);
        await send({ type: "speak", text: spoken });
        return;
      }

      const result = await requestWorker<ActionResult>({
        type: "retry-screenshot",
        command: permissionWorkflow.pendingCommand,
      });
      if (result?.workflow?.kind !== "clipboard-write") {
        throw new Error("Screenshot was not ready to copy");
      }
      await receiveClipboardWorkflow(result.workflow);
      return;
    }

    await completeClipboardWorkflow(clipboardWorkflow!);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Clipboard write failed";
    appendLog("copy screenshot", message);
  } finally {
    copyScreenshot.disabled = false;
  }
});

chrome.runtime.onMessage.addListener((raw: unknown) => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return;
  const record = raw as Record<string, unknown>;
  if (record.target !== "sidepanel") return;
  if (!validatesV02PanelPayload(record)) {
    console.warn("Sotto rejected an invalid side-panel message", record.type);
    return;
  }
  const message = record as unknown as PanelMessage;

  switch (message.type) {
    case "engine-status":
      setListening(message.listening);
      showNanoState(message.nano);
      showMicrophoneState(message.mic);
      if (message.error) appendLog("system", message.error);
      break;
    case "premium-tts-state":
      showPremiumVoiceState(
        message.state,
        message.enabled,
        message.backend,
        message.error,
      );
      break;
    case "premium-stt-state":
      showPremiumSttState(
        message.state,
        message.enabled,
        message.downloaded,
        message.resident,
        message.tier,
        message.resumable,
        message.error,
      );
      break;
    case "stt-diagnostic":
      showTranscript(message.message);
      transcript.dataset.diagnostic = message.diagnostic;
      appendLog(`speech / ${message.diagnostic}`, message.message);
      break;
    case "listening-state":
      setListening(message.listening);
      break;
    case "speech-start":
      listeningMark.textContent = "SPEECH";
      listeningMark.dataset.active = "true";
      micMeter.dataset.state = "speech";
      break;
    case "speech-end":
      if (isListening) {
        listeningMark.textContent = "LIVE";
        listeningMark.dataset.active = "true";
        micMeter.dataset.state = "listening";
      }
      break;
    case "mic-level":
      showMicLevel(message.level);
      break;
    case "transcript":
      showTranscript(message.text);
      break;
    case "model-progress":
      updateProgress(
        message.model,
        message.progress,
        message.model === "stt"
          ? message.status === "ready"
          : message.model === "premium-stt"
            ? message.status === "ready"
            : message.progress >= 1,
        message.file,
        message.loaded,
        message.total,
      );
      break;
    case "page-text":
      readingProgress.hidden = true;
      showPageText(message.text, message.title ?? "PAGE");
      break;
    case "rewrite-fallback":
      readingProgress.hidden = true;
      showPageText(message.text, "REWRITE NOT INSERTED");
      appendLog(
        "rewrite",
        "The editor changed; generated text is shown without inserting it",
      );
      break;
    case "reading-progress":
      readingProgress.hidden = false;
      readingProgress.max = Math.max(1, message.total);
      readingProgress.value = Math.max(
        0,
        Math.min(readingProgress.max, message.current),
      );
      break;
    case "notes-updated":
      renderNotes(message.notes);
      break;
    case "reminder-fired":
    case "reminder-opened":
      showReminder(message.reminder, message.type === "reminder-fired");
      break;
    case "earcon":
      void playEarcon(message.kind);
      break;
    case "action-log":
      appendLog(message.heard, message.did, message.timings);
      break;
    case "screenshot-ready":
      void receiveClipboardWorkflow(message.workflow);
      break;
    case "screenshot-permission-needed":
      pendingScreenshot = undefined;
      pendingScreenshotPermission = message.workflow;
      copyScreenshot.textContent = "Enable screen capture (one-time)";
      clipboardCopy.textContent =
        `Sotto needs one-time access to capture ${message.workflow.host}.`;
      clipboardCard.hidden = false;
      break;
    case "pipeline-error":
      setStatus("error", "Needs attention");
      pipelineError.textContent = message.message;
      appendLog("system", message.message, undefined, false);
      break;
  }
});

async function showAssignedShortcut(): Promise<void> {
  try {
    const commands = await chrome.commands.getAll();
    const shortcut =
      commands.find((command) => command.name === "toggle-sotto")?.shortcut ?? "";
    shortcutLabel.textContent = shortcut || "UNASSIGNED";
    if (!shortcut) {
      appendLog(
        "shortcut",
        "Assign Toggle Sotto at chrome://extensions/shortcuts",
      );
    }
  } catch (error) {
    console.warn("Sotto could not read its assigned shortcut", error);
  }
}

async function showReminderFromLocation(): Promise<void> {
  if (typeof location === "undefined" || !location.hash.startsWith("#")) return;
  const reminderId = new URLSearchParams(location.hash.slice(1)).get("reminder");
  if (
    !reminderId ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(reminderId)
  ) {
    return;
  }
  try {
    const reminder = await requestWorker<{
      readonly id: string;
      readonly text: string;
      readonly dueAt: string;
    }>({ type: "get-reminder", reminderId });
    if (
      reminder?.id === reminderId &&
      typeof reminder.text === "string" &&
      reminder.text.length >= 1 &&
      reminder.text.length <= 1_000 &&
      typeof reminder.dueAt === "string" &&
      Number.isFinite(Date.parse(reminder.dueAt))
    ) {
      showReminder(reminder);
    }
  } catch (error) {
    appendLog(
      "reminder",
      error instanceof Error ? error.message : "Reminder is unavailable",
    );
  }
}

showTranscript("");
micMeter.dataset.state = "idle";
micMeterFill.style.transform = "scaleX(0)";
void send({ type: "get-status" });
void requestWorker<readonly PanelNote[]>({ type: "get-notes" })
  .then((notes) => {
    if (notes) renderNotes(notes);
  })
  .catch((error: unknown) => {
    appendLog(
      "notes",
      error instanceof Error ? error.message : "Notes are unavailable",
    );
  });
void loadCapturePermissionState();
void showAssignedShortcut();
void showReminderFromLocation();
