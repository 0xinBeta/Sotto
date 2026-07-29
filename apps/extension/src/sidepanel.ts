import type {
  ActionResult,
  ClipboardWorkflow,
  ScreenshotPermissionWorkflow,
} from "@sotto/core";
import {
  MAX_NOTE_BODY_LENGTH,
  MAX_NOTES,
  MAX_PENDING_REMINDERS,
} from "@sotto/actions/notes/storage";
import { sanitizeHostname } from "@sotto/actions";
import { performClipboardWorkflow } from "@sotto/destinations";
import type { TtsProgressEventType } from "@sotto/tts";
import {
  isKokoroVoiceId,
  KOKORO_VOICE,
  KOKORO_VOICES,
  type KokoroVoiceId,
} from "@sotto/tts/kokoro-voices";
import { nextLogEntry, type LogEntry } from "./log.js";
import {
  formatExchangeTimings,
  formatLatencyDuration,
  isExchangeTimings,
  isLatencyStatistics,
  type ExchangeTimings,
  type LatencyStageStatistics,
  type LatencyStatistics,
} from "./timings.js";
import {
  isCommandReference,
  renderCommandReference,
} from "./command-reference.js";
import {
  clampSpeechRate,
  clampSpeechVolume,
  DEFAULT_SPEECH_SETTINGS,
  isResponseVerbosity,
  type SpeechSettings,
} from "./speech-settings.js";
import {
  activeReadingSentenceIndex,
  createReadingPlan,
  type ReadingPlan,
  type ReadingProgressPoint,
} from "./reading-progress.js";
import {
  deriveSetupViewState,
  type NanoSetupState,
  type PremiumSpeechSetupState,
  type PremiumVoiceSetupState,
  type SetupRowId,
  type SetupRowState,
} from "./setup-view.js";
import {
  RECOVERY_ERROR_CLASSES,
  recoveryHint,
  type RecoveryErrorClass,
} from "./recovery-hint.js";
import { localizePanel, t } from "./panel-i18n.js";
import { hostnameMatchesBlocked } from "./blocked-sites.js";
import {
  SESSION_HISTORY_LIMIT,
  type SessionHistoryEntry,
  type SessionHistoryState,
} from "./session-history.js";
import "./styles.css";

localizePanel();

type NanoAvailability = NanoSetupState;
type ModelProgressKind =
  | "nano"
  | "stt"
  | "summarizer"
  | "translator"
  | "rewriter"
  | "premium-tts"
  | "premium-stt";
type PremiumTtsState = PremiumVoiceSetupState;
type PremiumSttState = PremiumSpeechSetupState;
type PremiumSttTier = "parakeet" | "moonshine-base";
type SttDiagnostic =
  | "vad-rejected"
  | "blank-result"
  | "timeout"
  | "webgpu-failed";
type PanelModelId =
  | "moonshine-tiny"
  | "moonshine-base"
  | "parakeet-v3"
  | "kokoro"
  | `kokoro-voice:${string}`
  | "gemini-nano"
  | "summarizer";
type PanelModelState = "active" | "cached" | "absent" | "downloading";

interface PanelModelRow {
  readonly id: PanelModelId;
  readonly label: string;
  readonly detail?: string;
  readonly state: PanelModelState;
  readonly readOnly: boolean;
  readonly bytes?: number;
  readonly canDownload: boolean;
  readonly canDelete: boolean;
}

interface PanelNote {
  readonly id: string;
  readonly body: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface PanelReminder {
  readonly id: string;
  readonly text: string;
  readonly dueAt: string;
}

interface BlockedSitesState {
  readonly hostnames: readonly string[];
  readonly currentHostname?: string;
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

function isSessionHistoryEntry(
  value: unknown,
): value is SessionHistoryEntry {
  if (!isRecord(value)) return false;
  return (
    Object.keys(value).length === 4 &&
    Object.hasOwn(value, "timestamp") &&
    Object.hasOwn(value, "transcript") &&
    Object.hasOwn(value, "actionId") &&
    Object.hasOwn(value, "resultLine") &&
    isBoundedString(value.timestamp, 35, 1) &&
    Number.isFinite(Date.parse(value.timestamp)) &&
    isBoundedString(value.transcript, 2_000, 1) &&
    isBoundedString(value.actionId, 100, 1) &&
    isBoundedString(value.resultLine, 2_000, 1)
  );
}

function isSessionHistoryState(
  value: unknown,
): value is SessionHistoryState {
  if (!isRecord(value) || !Array.isArray(value.entries)) return false;
  return (
    Object.keys(value).length === 2 &&
    typeof value.enabled === "boolean" &&
    value.entries.length <= SESSION_HISTORY_LIMIT &&
    value.entries.every(isSessionHistoryEntry) &&
    (value.enabled || value.entries.length === 0)
  );
}

function isPanelNote(value: unknown): value is PanelNote {
  if (!isRecord(value)) return false;
  return (
    isBoundedString(value.id, 128, 1) &&
    isBoundedString(value.body, MAX_NOTE_BODY_LENGTH, 1) &&
    isBoundedString(value.createdAt, 35, 1) &&
    isBoundedString(value.updatedAt, 35, 1) &&
    Number.isFinite(Date.parse(value.createdAt)) &&
    Number.isFinite(Date.parse(value.updatedAt))
  );
}

function isPanelReminder(value: unknown): value is PanelReminder {
  if (!isRecord(value)) return false;
  return (
    Object.keys(value).every((key) =>
      key === "id" || key === "text" || key === "dueAt"
    ) &&
    isBoundedString(value.id, 128, 1) &&
    isBoundedString(value.text, 1_000, 1) &&
    isBoundedString(value.dueAt, 35, 1) &&
    Number.isFinite(Date.parse(value.dueAt))
  );
}

function isPanelModelId(value: unknown): value is PanelModelId {
  return value === "moonshine-tiny" ||
    value === "moonshine-base" ||
    value === "parakeet-v3" ||
    value === "kokoro" ||
    value === "gemini-nano" ||
    value === "summarizer" ||
    (typeof value === "string" &&
      /^kokoro-voice:[a-z]{2}_[a-z]+$/.test(value));
}

function isPanelModelRow(value: unknown): value is PanelModelRow {
  if (!isRecord(value)) return false;
  return (
    isPanelModelId(value.id) &&
    isBoundedString(value.label, 100, 1) &&
    (value.detail === undefined ||
      isBoundedString(value.detail, 200, 1)) &&
    (
      value.state === "active" ||
      value.state === "cached" ||
      value.state === "absent" ||
      value.state === "downloading"
    ) &&
    typeof value.readOnly === "boolean" &&
    (
      value.bytes === undefined ||
      (
        typeof value.bytes === "number" &&
        Number.isSafeInteger(value.bytes) &&
        value.bytes >= 0
      )
    ) &&
    typeof value.canDownload === "boolean" &&
    typeof value.canDelete === "boolean" &&
    (!value.readOnly || (!value.canDownload && !value.canDelete)) &&
    (value.id !== "moonshine-tiny" || !value.canDelete)
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
  | { target: "sidepanel"; type: "quiet-mode-state"; enabled: boolean }
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
      type: "session-history-entry";
      entry: SessionHistoryEntry;
      count: number;
    }
  | {
      target: "sidepanel";
      type: "latency-statistics";
      statistics: LatencyStatistics;
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
      chunkIndex?: number;
      chunkCount?: number;
      chunkCharIndex?: number;
      eventType?: TtsProgressEventType;
    }
  | {
      target: "sidepanel";
      type: "reading-state";
      active: boolean;
      paused: boolean;
    }
  | {
      target: "sidepanel";
      type: "dictation-state";
      active: boolean;
      paused: boolean;
    }
  | {
      target: "sidepanel";
      type: "notes-updated";
      notes: readonly PanelNote[];
    }
  | {
      target: "sidepanel";
      type: "reminders-updated";
      reminders: readonly PanelReminder[];
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
  | {
      target: "sidepanel";
      type: "pipeline-error";
      message: string;
      errorClass?: RecoveryErrorClass;
    }
  | {
      target: "sidepanel";
      type: "premium-tts-state";
      state: PremiumTtsState;
      enabled: boolean;
      voice: KokoroVoiceId;
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
    }
  | {
      target: "sidepanel";
      type: "model-inventory";
      rows: readonly PanelModelRow[];
      totalBytes: number;
    }
  | { target: "sidepanel"; type: "show-command-reference" };

function validatesV02PanelPayload(message: Record<string, unknown>): boolean {
  switch (message.type) {
    case "quiet-mode-state":
      return typeof message.enabled === "boolean";
    case "action-log":
      return (
        isBoundedString(message.heard, 2_000, 1) &&
        isBoundedString(message.did, 2_000, 1) &&
        (message.timings === undefined ||
          isExchangeTimings(message.timings))
      );
    case "session-history-entry":
      return (
        Object.keys(message).length === 4 &&
        isSessionHistoryEntry(message.entry) &&
        typeof message.count === "number" &&
        Number.isSafeInteger(message.count) &&
        message.count >= 1 &&
        message.count <= SESSION_HISTORY_LIMIT
      );
    case "latency-statistics":
      return isLatencyStatistics(message.statistics);
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
      if (command.action === "ask-screen") {
        return (
          Object.keys(command).every((key) =>
            key === "action" || key === "question"
          ) &&
          (command.question === undefined ||
            isBoundedString(command.question, 1_000, 1))
        );
      }
      return (
        Object.keys(command).length === 2 &&
        command.action === "screenshot" &&
        (command.destination === "copy" ||
          command.destination === "save" ||
          command.destination === "claude" ||
          command.destination === "chatgpt" ||
          command.destination === "gemini")
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
        message.current <= message.total &&
        (
          (
            message.chunkIndex === undefined &&
            message.chunkCount === undefined &&
            message.chunkCharIndex === undefined &&
            message.eventType === undefined
          ) ||
          (
            typeof message.chunkIndex === "number" &&
            Number.isInteger(message.chunkIndex) &&
            message.chunkIndex >= 0 &&
            typeof message.chunkCount === "number" &&
            Number.isInteger(message.chunkCount) &&
            message.chunkCount > 0 &&
            message.chunkIndex < message.chunkCount &&
            typeof message.chunkCharIndex === "number" &&
            Number.isInteger(message.chunkCharIndex) &&
            message.chunkCharIndex >= 0 &&
            (
              message.eventType === "start" ||
              message.eventType === "word" ||
              message.eventType === "sentence" ||
              message.eventType === "marker" ||
              message.eventType === "end"
            )
          )
        )
      );
    case "reading-state":
      return (
        typeof message.active === "boolean" &&
        typeof message.paused === "boolean" &&
        (!message.paused || message.active)
      );
    case "dictation-state":
      return (
        typeof message.active === "boolean" &&
        typeof message.paused === "boolean" &&
        (!message.paused || message.active)
      );
    case "notes-updated":
      return (
        Array.isArray(message.notes) &&
        message.notes.length <= 5_000 &&
        message.notes.every(isPanelNote)
      );
    case "reminders-updated":
      return (
        Array.isArray(message.reminders) &&
        message.reminders.length <= 5_000 &&
        message.reminders.every(isPanelReminder)
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
          message.model === "translator" ||
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
    case "model-inventory":
      return (
        Array.isArray(message.rows) &&
        message.rows.length >= 4 &&
        message.rows.length <= 40 &&
        message.rows.every(isPanelModelRow) &&
        typeof message.totalBytes === "number" &&
        Number.isSafeInteger(message.totalBytes) &&
        message.totalBytes >= 0 &&
        message.totalBytes === message.rows.reduce(
          (total, row) =>
            total +
            (
              isRecord(row) && typeof row.bytes === "number"
                ? row.bytes
                : 0
            ),
          0,
        )
      );
    case "premium-tts-state":
      return (
        (message.state === "absent" ||
          message.state === "downloading" ||
          message.state === "ready" ||
          message.state === "error") &&
        typeof message.enabled === "boolean" &&
        isKokoroVoiceId(message.voice) &&
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
    case "pipeline-error":
      return (
        isBoundedString(message.message, 1_000, 1) &&
        (
          message.errorClass === undefined ||
          RECOVERY_ERROR_CLASSES.includes(
            message.errorClass as RecoveryErrorClass,
          )
        )
      );
    case "mic-level":
      return (
        typeof message.level === "number" &&
        Number.isFinite(message.level) &&
        message.level >= 0 &&
        message.level <= 1
      );
    case "show-command-reference":
      return Object.keys(message).every((key) =>
        key === "target" || key === "type"
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
const quietModeControl =
  requiredElement<HTMLElement>("#quiet-mode-control");
const quietModeToggle =
  requiredElement<HTMLInputElement>("#quiet-mode");
const quietModeLabel =
  requiredElement<HTMLElement>("#quiet-mode-label");
const pipelineError = requiredElement<HTMLElement>("#pipeline-error");
const setupView = requiredElement<HTMLElement>("#setup-view");
const setupList = requiredElement<HTMLOListElement>("#setup-list");
const setupComplete = requiredElement<HTMLElement>("#setup-complete");
const dismissSetup = requiredElement<HTMLButtonElement>("#dismiss-setup");
const setupRows: Record<
  SetupRowId,
  {
    readonly row: HTMLElement;
    readonly icon: HTMLElement;
    readonly state: HTMLElement;
  }
> = {
  microphone: {
    row: requiredElement<HTMLElement>("#setup-microphone"),
    icon: requiredElement<HTMLElement>("#setup-microphone-icon"),
    state: requiredElement<HTMLElement>("#setup-microphone-state"),
  },
  capture: {
    row: requiredElement<HTMLElement>("#setup-capture"),
    icon: requiredElement<HTMLElement>("#setup-capture-icon"),
    state: requiredElement<HTMLElement>("#setup-capture-state"),
  },
  nano: {
    row: requiredElement<HTMLElement>("#setup-nano"),
    icon: requiredElement<HTMLElement>("#setup-nano-icon"),
    state: requiredElement<HTMLElement>("#setup-nano-state"),
  },
  premium: {
    row: requiredElement<HTMLElement>("#setup-premium"),
    icon: requiredElement<HTMLElement>("#setup-premium-icon"),
    state: requiredElement<HTMLElement>("#setup-premium-state"),
  },
};
const enableCapture = requiredElement<HTMLButtonElement>("#enable-capture");
const setupGrantMic = requiredElement<HTMLButtonElement>("#setup-grant-mic");
const setupPrepareNano = requiredElement<HTMLButtonElement>("#setup-prepare-nano");
const setupDownloadPremium =
  requiredElement<HTMLButtonElement>("#setup-download-premium");
const transcript = requiredElement<HTMLElement>("#transcript");
const listeningMark = requiredElement<HTMLElement>("#listening-mark");
const listenButton = requiredElement<HTMLButtonElement>("#listen-button");
const listenLabel = requiredElement<HTMLElement>("#listen-label");
const micMeter = requiredElement<HTMLElement>("#mic-meter");
const micMeterFill = requiredElement<HTMLElement>("#mic-meter-fill");
const shortcutLabel = requiredElement<HTMLElement>("#shortcut-label");
const readPageShortcutLabel =
  requiredElement<HTMLElement>("#read-page-shortcut-label");
const grantMic = requiredElement<HTMLButtonElement>("#grant-mic");
const commandForm = requiredElement<HTMLFormElement>("#command-form");
const commandInput = requiredElement<HTMLInputElement>("#command-input");
const dictationCard = requiredElement<HTMLElement>("#dictation-card");
const dictationCopy = requiredElement<HTMLElement>("#dictation-copy");
const resumeDictation =
  requiredElement<HTMLButtonElement>("#resume-dictation");
const clipboardCard = requiredElement<HTMLElement>("#clipboard-card");
const clipboardCopy = requiredElement<HTMLElement>("#clipboard-copy");
const copyScreenshot = requiredElement<HTMLButtonElement>("#copy-screenshot");
const actionLog = requiredElement<HTMLOListElement>("#action-log");
const actionLogAnnouncer =
  requiredElement<HTMLElement>("#action-log-announcer");
const clearLog = requiredElement<HTMLButtonElement>("#clear-log");
const sessionHistoryEnabled =
  requiredElement<HTMLInputElement>("#session-history-enabled");
const sessionHistoryPanel =
  requiredElement<HTMLElement>("#session-history-panel");
const sessionHistoryList =
  requiredElement<HTMLOListElement>("#session-history-list");
const clearSessionHistory =
  requiredElement<HTMLButtonElement>("#clear-session-history");
const latencyReadout =
  requiredElement<HTMLDetailsElement>("#latency-readout");
const latencySummary =
  requiredElement<HTMLElement>("#latency-summary");
const latencyDetails =
  requiredElement<HTMLTableSectionElement>("#latency-details");
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
const premiumVoicePicker =
  requiredElement<HTMLFieldSetElement>("#premium-voice-picker");
const premiumVoiceOptions =
  requiredElement<HTMLElement>("#premium-voice-options");
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
const modelsList =
  requiredElement<HTMLUListElement>("#models-list");
const modelsTotal =
  requiredElement<HTMLOutputElement>("#models-total");
const speechRate =
  requiredElement<HTMLInputElement>("#speech-rate");
const speechRateValue =
  requiredElement<HTMLOutputElement>("#speech-rate-value");
const speechVolume =
  requiredElement<HTMLInputElement>("#speech-volume");
const speechVolumeValue =
  requiredElement<HTMLOutputElement>("#speech-volume-value");
const responseVerbosity =
  requiredElement<HTMLSelectElement>("#response-verbosity");
const blockedSiteForm =
  requiredElement<HTMLFormElement>("#blocked-site-form");
const blockedSiteInput =
  requiredElement<HTMLInputElement>("#blocked-site-input");
const addBlockedSite =
  requiredElement<HTMLButtonElement>("#add-blocked-site");
const blockCurrentSite =
  requiredElement<HTMLButtonElement>("#block-current-site");
const blockedSitesList =
  requiredElement<HTMLUListElement>("#blocked-sites-list");
const blockedSitesStatus =
  requiredElement<HTMLElement>("#blocked-sites-status");
const copyDiagnosticReport =
  requiredElement<HTMLButtonElement>("#copy-diagnostic-report");
const exportSettingsBackup =
  requiredElement<HTMLButtonElement>("#export-settings-backup");
const chooseSettingsBackup =
  requiredElement<HTMLButtonElement>("#choose-settings-backup");
const settingsBackupFile =
  requiredElement<HTMLInputElement>("#settings-backup-file");
const settingsBackupStatus =
  requiredElement<HTMLElement>("#settings-backup-status");
const settingsBackupConfirm =
  requiredElement<HTMLElement>("#settings-backup-confirm");
const settingsBackupConfirmCopy =
  requiredElement<HTMLElement>("#settings-backup-confirm-copy");
const confirmSettingsImport =
  requiredElement<HTMLButtonElement>("#confirm-settings-import");
const cancelSettingsImport =
  requiredElement<HTMLButtonElement>("#cancel-settings-import");
const pageTextCard = requiredElement<HTMLElement>("#page-text-card");
const pageTextTitle = requiredElement<HTMLElement>("#page-text-title");
const pageTextOutput = requiredElement<HTMLElement>("#page-text-output");
const readingTextOutput =
  requiredElement<HTMLElement>("#reading-text-output");
const closePageText = requiredElement<HTMLButtonElement>("#close-page-text");
const readingProgress = requiredElement<HTMLProgressElement>("#reading-progress");
const readingControls = requiredElement<HTMLElement>("#reading-controls");
const pauseReading = requiredElement<HTMLButtonElement>("#pause-reading");
const skipReading = requiredElement<HTMLButtonElement>("#skip-reading");
const notesList = requiredElement<HTMLUListElement>("#notes-list");
const notesSearch = requiredElement<HTMLInputElement>("#notes-search");
const exportNotes = requiredElement<HTMLButtonElement>("#export-notes");
const notesCount = requiredElement<HTMLElement>("#notes-count");
const remindersList =
  requiredElement<HTMLUListElement>("#reminders-list");
const remindersCount =
  requiredElement<HTMLElement>("#reminders-count");
const reminderBanner = requiredElement<HTMLElement>("#reminder-banner");
const commandReference =
  requiredElement<HTMLDetailsElement>("#command-reference");
const commandReferenceList =
  requiredElement<HTMLElement>("#command-reference-list");

let isListening = false;
let isQuietMode = false;
let isReading = false;
let isReadingPaused = false;
let readingView:
  | {
      readonly plan: ReadingPlan;
      readonly elements: readonly HTMLElement[];
      activeSentence: number;
    }
  | undefined;
let isDictating = false;
let isDictationPaused = false;
let panelNotes: readonly PanelNote[] = [];
let panelReminders: readonly PanelReminder[] = [];
let pendingScreenshot: ClipboardWorkflow | undefined;
let pendingScreenshotPermission: ScreenshotPermissionWorkflow | undefined;
let newestLogEntry: LogEntry | undefined;
let currentSessionHistory: SessionHistoryState = {
  enabled: false,
  entries: [],
};
let pointerIsDown = false;
let earconContext: AudioContext | undefined;
let setupDismissed = false;
let microphonePermission: PermissionState | "unknown" = "unknown";
let capturePermissionGranted: boolean | undefined;
let nanoAvailability: NanoAvailability | undefined;
let premiumState: PremiumTtsState = "absent";
let premiumSetupVoiceState: PremiumTtsState | undefined;
let selectedPremiumVoice: KokoroVoiceId = KOKORO_VOICE;
let premiumVoicePreviewPending = false;
const premiumVoiceInputs = new Map<KokoroVoiceId, HTMLInputElement>();
let highAccuracyState: PremiumSttState = "not-downloaded";
let premiumSetupSpeechState: PremiumSttState | undefined;
let highAccuracyTier: PremiumSttTier = "moonshine-base";
let highAccuracyResumable = false;
let pendingSettingsBackup: string | undefined;
let meterAccessibleTimer: number | undefined;
let pendingMeterAccessibleValue: number | undefined;
let lastMeterAccessibleUpdate = Number.NEGATIVE_INFINITY;
const progressHideTimers:
  Partial<Record<"nano" | "stt" | "premium-tts" | "premium-stt", number>> = {};
const METER_ACCESSIBLE_INTERVAL_MS = 500;
const MAX_SETTINGS_BACKUP_FILE_BYTES = 20 * 1024 * 1024;

function isSpeechSettings(value: unknown): value is SpeechSettings {
  if (!isRecord(value)) return false;
  return (
    typeof value.rate === "number" &&
    Number.isFinite(value.rate) &&
    typeof value.volume === "number" &&
    Number.isFinite(value.volume) &&
    isResponseVerbosity(value.verbosity)
  );
}

function isBlockedSitesState(value: unknown): value is BlockedSitesState {
  if (!isRecord(value) || !Array.isArray(value.hostnames)) return false;
  const hostnames = value.hostnames;
  if (
    hostnames.length > 5_000 ||
    !hostnames.every((hostname) =>
      typeof hostname === "string" &&
      sanitizeHostname(hostname) === hostname
    ) ||
    new Set(hostnames).size !== hostnames.length
  ) {
    return false;
  }
  return (
    value.currentHostname === undefined ||
    (
      typeof value.currentHostname === "string" &&
      sanitizeHostname(value.currentHostname) === value.currentHostname
    )
  );
}

function showBlockedSitesStatus(message: string): void {
  blockedSitesStatus.textContent = message;
}

function showBlockedSites(state: BlockedSitesState): void {
  const { currentHostname, hostnames } = state;
  blockCurrentSite.textContent = currentHostname === undefined
    ? t("blockThisSite")
    : t("blockThisSiteName", currentHostname);
  blockCurrentSite.disabled =
    currentHostname === undefined ||
    hostnameMatchesBlocked(currentHostname, hostnames);

  blockedSitesList.replaceChildren();
  if (hostnames.length === 0) {
    const empty = document.createElement("li");
    empty.textContent = t("noBlockedSites");
    blockedSitesList.append(empty);
    return;
  }

  for (const hostname of hostnames) {
    const row = document.createElement("li");
    row.className = "blocked-site-row";
    const label = document.createElement("span");
    label.textContent = hostname;
    const remove = document.createElement("button");
    remove.className = "button";
    remove.type = "button";
    remove.textContent = t("delete");
    remove.setAttribute("aria-label", t("removeBlockedSite", hostname));
    remove.addEventListener("click", async () => {
      remove.disabled = true;
      showBlockedSitesStatus("");
      try {
        const next = await requestWorker<unknown>({
          type: "remove-blocked-site",
          hostname,
        });
        if (!isBlockedSitesState(next)) {
          throw new TypeError("The blocked site list is invalid.");
        }
        showBlockedSites(next);
      } catch {
        showBlockedSitesStatus(t("blockedSitesUnavailable"));
        remove.disabled = false;
      }
    });
    row.append(label, remove);
    blockedSitesList.append(row);
  }
}

async function loadBlockedSites(): Promise<void> {
  try {
    const state = await requestWorker<unknown>({
      type: "get-blocked-sites",
    });
    if (!isBlockedSitesState(state)) {
      throw new TypeError("The blocked site list is invalid.");
    }
    showBlockedSites(state);
  } catch {
    showBlockedSitesStatus(t("blockedSitesUnavailable"));
    blockCurrentSite.disabled = true;
  }
}

function currentSpeechSettings(): SpeechSettings {
  const rate = Number(speechRate.value);
  const volume = Number(speechVolume.value);
  return {
    rate: clampSpeechRate(
      Number.isFinite(rate) ? rate : DEFAULT_SPEECH_SETTINGS.rate,
    ),
    volume: clampSpeechVolume(
      Number.isFinite(volume) ? volume : DEFAULT_SPEECH_SETTINGS.volume,
    ),
    verbosity: isResponseVerbosity(responseVerbosity.value)
      ? responseVerbosity.value
      : DEFAULT_SPEECH_SETTINGS.verbosity,
  };
}

function showSpeechSettings(settings: SpeechSettings): void {
  const rate = clampSpeechRate(settings.rate);
  const volume = clampSpeechVolume(settings.volume);
  const rateText = rate.toFixed(1);
  const volumePercent = Math.round(volume * 100);
  speechRate.value = String(rate);
  speechRateValue.value = `${rateText}×`;
  speechRateValue.textContent = speechRateValue.value;
  speechRate.setAttribute("aria-valuetext", t("speechRateTimes", rateText));
  speechVolume.value = String(volume);
  speechVolumeValue.value = `${volumePercent}%`;
  speechVolumeValue.textContent = speechVolumeValue.value;
  speechVolume.setAttribute(
    "aria-valuetext",
    t("speechVolumePercent", String(volumePercent)),
  );
  responseVerbosity.value = settings.verbosity;
}

function showQuietMode(enabled: boolean): void {
  isQuietMode = enabled;
  quietModeToggle.checked = enabled;
  quietModeControl.dataset.state = enabled ? "on" : "off";
  quietModeLabel.textContent =
    enabled ? t("quietModeOn") : t("quietModeOff");
}

async function loadQuietMode(): Promise<void> {
  try {
    const enabled = await requestWorker<unknown>({
      type: "get-quiet-mode",
    });
    showQuietMode(enabled === true);
  } catch {
    showQuietMode(false);
    appendLog(t("logQuietMode"), t("quietModeUnavailable"));
  }
}

async function saveSpeechSettings(): Promise<void> {
  const settings = currentSpeechSettings();
  showSpeechSettings(settings);
  try {
    const saved = await requestWorker<unknown>({
      type: "set-speech-settings",
      ...settings,
    });
    if (isSpeechSettings(saved)) showSpeechSettings(saved);
  } catch {
    appendLog(t("logSpeechSettings"), t("speechSettingsSaveFailed"));
  }
}

async function loadSpeechSettings(): Promise<void> {
  showSpeechSettings(DEFAULT_SPEECH_SETTINGS);
  try {
    const settings = await requestWorker<unknown>({
      type: "get-speech-settings",
    });
    if (isSpeechSettings(settings)) showSpeechSettings(settings);
  } catch {
    appendLog(t("logSpeechSettings"), t("speechSettingsUnavailable"));
  }
}

copyDiagnosticReport.addEventListener("click", async () => {
  copyDiagnosticReport.disabled = true;
  try {
    const report = await requestWorker<unknown>({
      type: "get-diagnostic-report",
    });
    if (
      typeof report !== "string" ||
      !report.startsWith("# Sotto diagnostic report\n") ||
      report.split("\n").length > 120
    ) {
      throw new Error(t("diagnosticReportInvalid"));
    }
    if (!navigator.clipboard?.writeText) {
      throw new Error(t("textClipboardUnavailable"));
    }
    await navigator.clipboard.writeText(report);
    appendLog(t("logDiagnosticReport"), t("diagnosticReportCopied"));
  } catch (error) {
    appendLog(
      t("logDiagnosticReport"),
      error instanceof Error
        ? error.message
        : t("diagnosticReportCopyFailed"),
    );
  } finally {
    copyDiagnosticReport.disabled = false;
  }
});

function selectPremiumVoiceInput(voice: KokoroVoiceId): void {
  for (const [voiceId, input] of premiumVoiceInputs) {
    input.checked = voiceId === voice;
  }
}

async function previewPremiumVoice(voice: KokoroVoiceId): Promise<void> {
  if (premiumState !== "ready" || premiumVoicePreviewPending) return;
  const previousVoice = selectedPremiumVoice;
  selectPremiumVoiceInput(voice);
  premiumVoicePreviewPending = true;
  premiumVoicePicker.disabled = true;
  try {
    await requestWorker({
      type: "preview-premium-tts-voice",
      voice,
    });
    selectedPremiumVoice = voice;
  } catch {
    selectedPremiumVoice = previousVoice;
    selectPremiumVoiceInput(previousVoice);
    appendLog(
      t("logVoicePreview"),
      t("voicePreviewFailed"),
      undefined,
      true,
      "tts-failure",
    );
  } finally {
    premiumVoicePreviewPending = false;
    premiumVoicePicker.disabled = premiumState !== "ready";
  }
}

function renderPremiumVoiceOptions(): void {
  const rows = KOKORO_VOICES.map((voice) => {
    const row = document.createElement("div");
    const input = document.createElement("input");
    const label = document.createElement("label");
    const accent = document.createElement("span");
    const preview = document.createElement("button");
    const inputId = `premium-voice-${voice.id}`;

    row.className = "premium-voice-option";
    input.type = "radio";
    input.name = "premium-voice";
    input.id = inputId;
    input.value = voice.id;
    input.checked = voice.id === selectedPremiumVoice;
    input.addEventListener("change", () => {
      if (input.checked) void previewPremiumVoice(voice.id);
    });
    label.htmlFor = inputId;
    label.textContent = voice.label;
    accent.className = "premium-voice-accent";
    accent.textContent = t("accentEnglish", voice.accent);
    preview.className = "premium-voice-preview";
    preview.type = "button";
    preview.textContent = t("preview");
    preview.setAttribute("aria-label", t("previewVoice", voice.label));
    preview.addEventListener("click", () => {
      void previewPremiumVoice(voice.id);
    });
    row.append(input, label, accent, preview);
    premiumVoiceInputs.set(voice.id, input);
    return row;
  });
  premiumVoiceOptions.replaceChildren(...rows);
}

renderPremiumVoiceOptions();

function setStatus(
  state: "booting" | "ready" | "listening" | "error",
  label: string,
): void {
  statusChip.dataset.state = state;
  statusLabel.textContent = label;
}

function renderRecoveryMessage(
  element: HTMLElement,
  message: string,
  errorClass?: RecoveryErrorClass,
): void {
  element.textContent = message;
  if (!errorClass) return;
  const hint = recoveryHint(errorClass);
  if (!hint) return;
  const hintLine = document.createElement("span");
  hintLine.className = "recovery-hint";
  hintLine.textContent = hint;
  element.append(hintLine);
}

function setListening(listening: boolean): void {
  isListening = listening;
  listenButton.setAttribute("aria-pressed", String(listening));
  listenLabel.textContent = isDictating
    ? isDictationPaused
      ? t("dictationPaused")
      : t("stopDictation")
    : listening
      ? t("listeningEllipsis")
      : t("holdToTalk");
  listeningMark.textContent = isDictating
    ? t("dictation")
    : listening
      ? t("stateLive")
      : t("stateIdle");
  listeningMark.dataset.active = String(listening || isDictating);
  micMeter.dataset.state = listening ? "listening" : "idle";
  if (!listening) {
    micMeterFill.style.transform = "scaleX(0)";
    updateMeterAccessibleValue(0);
  }
  setStatus(
    isDictating || listening ? "listening" : "ready",
    isDictating
      ? isDictationPaused
        ? t("dictationPaused")
        : t("statusDictation")
      : listening
        ? t("statusListening")
        : t("statusOnDevice"),
  );
}

function showDictationState(active: boolean, paused: boolean): void {
  isDictating = active;
  isDictationPaused = paused;
  dictationCard.hidden = !active;
  resumeDictation.hidden = !paused;
  dictationCopy.textContent = paused
    ? t("dictationPausedCopy")
    : t("dictationActiveCopy");
  setListening(isListening);
  actionLogAnnouncer.textContent = !active
    ? t("dictationStoppedAnnouncement")
    : paused
      ? t("dictationPausedAnnouncement")
      : t("dictationActiveAnnouncement");
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

function showTranscript(
  text: string,
  errorClass?: RecoveryErrorClass,
): void {
  renderRecoveryMessage(
    transcript,
    text || t("transcriptPlaceholder"),
    errorClass,
  );
  transcript.dataset.placeholder = String(!text);
}

function updateReadingSentence(
  element: HTMLElement,
  state: "past" | "active" | "upcoming",
): void {
  element.dataset.state = state;
  if (state === "active") {
    element.setAttribute("aria-current", "true");
  } else {
    element.removeAttribute("aria-current");
  }
}

function showActiveReadingSentence(
  progress: ReadingProgressPoint,
  autoScroll = true,
): void {
  if (!readingView) return;
  const next = activeReadingSentenceIndex(readingView.plan, progress);
  if (next < 0 || next === readingView.activeSentence) return;

  for (const [index, element] of readingView.elements.entries()) {
    updateReadingSentence(
      element,
      index < next ? "past" : index === next ? "active" : "upcoming",
    );
  }
  readingView.activeSentence = next;
  if (
    autoScroll &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    readingView.elements[next]?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
    });
  }
}

function startReadingView(text: string): void {
  const plan = createReadingPlan(text);
  const elements: HTMLElement[] = [];
  readingTextOutput.replaceChildren();

  for (const [index, sentence] of plan.sentences.entries()) {
    if (index > 0) {
      readingTextOutput.append(document.createTextNode(" "));
    }
    const sentenceElement = document.createElement("span");
    sentenceElement.className = "reading-sentence";
    sentenceElement.textContent = sentence.text;
    readingTextOutput.append(sentenceElement);
    elements.push(sentenceElement);
  }

  readingView = { plan, elements, activeSentence: -1 };
  pageTextOutput.hidden = true;
  readingTextOutput.hidden = false;
  pageTextCard.hidden = false;
  showActiveReadingSentence({ charIndex: 0 }, false);
}

function clearReadingView(): void {
  readingView = undefined;
  readingTextOutput.replaceChildren();
  readingTextOutput.hidden = true;
  pageTextOutput.hidden = false;
  pageTextOutput.textContent = "";
  pageTextCard.hidden = true;
}

function showReadingState(active: boolean, paused: boolean): void {
  const wasReading = isReading;
  isReading = active;
  isReadingPaused = paused;
  if (active && !wasReading) {
    startReadingView(pageTextOutput.textContent);
  } else if (!active && readingView) {
    clearReadingView();
  }
  readingControls.hidden = !active;
  pauseReading.textContent = paused ? t("resume") : t("pause");
  pauseReading.setAttribute(
    "aria-label",
    paused ? t("resumeReading") : t("pauseReading"),
  );
  if (!active) readingProgress.hidden = true;
  actionLogAnnouncer.textContent = !active
    ? t("readingStoppedAnnouncement")
    : paused
      ? t("readingPausedAnnouncement")
      : t("readingActiveAnnouncement");
}

const SETUP_ICONS: Record<SetupRowState, string> = {
  done: "✓",
  pending: "…",
  "needs-action": "!",
};

const SETUP_STATE_LABELS: Record<SetupRowState, string> = {
  done: t("setupStateDone"),
  pending: t("setupStatePending"),
  "needs-action": t("setupStateNeedsAction"),
};

function renderSetupView(): void {
  const state = deriveSetupViewState({
    microphone: microphonePermission,
    capture: capturePermissionGranted,
    nano: nanoAvailability,
    premiumVoice: premiumSetupVoiceState,
    premiumSpeech: premiumSetupSpeechState,
  });

  setupGrantMic.hidden = true;
  enableCapture.hidden = true;
  setupPrepareNano.hidden = true;
  setupDownloadPremium.hidden = true;

  for (const row of state.rows) {
    const elements = setupRows[row.id];
    elements.row.dataset.state = row.state;
    elements.icon.textContent = SETUP_ICONS[row.state];
    const errorClass =
      row.id === "microphone" && microphonePermission === "denied"
        ? "mic-permission-denied"
        : row.id === "capture" && capturePermissionGranted === false
          ? "capture-permission"
          : row.id === "nano" && nanoAvailability === "unavailable"
            ? "nano-unavailable"
            : row.id === "premium" &&
                (
                  premiumState === "error" ||
                  (
                    highAccuracyState === "error" &&
                    highAccuracyResumable
                  )
                )
              ? "download-failure"
              : undefined;
    renderRecoveryMessage(
      elements.state,
      t("setupStateLine", SETUP_STATE_LABELS[row.state], row.description),
      errorClass,
    );

    switch (row.action) {
      case "microphone":
        setupGrantMic.hidden = false;
        setupGrantMic.disabled = false;
        setupGrantMic.textContent = microphonePermission === "denied"
          ? t("reviewMicrophoneSettings")
          : t("grantMicrophoneAccess");
        break;
      case "capture":
        enableCapture.hidden = false;
        break;
      case "nano":
        setupPrepareNano.hidden = false;
        setupPrepareNano.disabled = false;
        setupPrepareNano.textContent = nanoAvailability === "downloading"
          ? t("continueModelSetup")
          : t("prepareGeminiNano");
        break;
      case "premium-voice":
        setupDownloadPremium.hidden = false;
        setupDownloadPremium.disabled = false;
        setupDownloadPremium.textContent = premiumState === "error"
          ? t("retryVoiceDownload")
          : t("downloadPremiumVoice");
        break;
      case "premium-speech":
        setupDownloadPremium.hidden = false;
        setupDownloadPremium.disabled = false;
        setupDownloadPremium.textContent = highAccuracyResumable
          ? t("resumeSpeechDownload")
          : t("downloadSpeechModel");
        break;
    }
  }

  if (!state.complete) setupDismissed = false;
  setupView.hidden = state.complete && setupDismissed;
  setupView.dataset.state = state.complete ? "complete" : "expanded";
  setupList.hidden = state.complete;
  setupComplete.hidden = !state.complete;
}

function showNanoState(availability: NanoAvailability): void {
  nanoAvailability = availability;
  renderSetupView();

  if (availability === "unavailable") {
    setStatus("error", t("statusNanoUnavailable"));
    return;
  }

  if (availability === "downloadable" || availability === "downloading") {
    setStatus(
      "booting",
      availability === "downloading"
        ? t("statusNanoDownloading")
        : t("statusNanoSetup"),
    );
    return;
  }

  setStatus(
    isListening ? "listening" : "ready",
    isListening ? t("statusListening") : t("statusOnDevice"),
  );
}

function showMicrophoneState(state: PermissionState | "unknown"): void {
  microphonePermission = state;
  const granted = state === "granted";
  listenButton.disabled = !granted;
  const label =
    state === "denied"
      ? t("reviewMicrophoneSettings")
      : t("grantMicrophoneAccess");
  grantMic.textContent = label;
  renderSetupView();
  if (granted) return;

  listenLabel.textContent = t("useTextCommand");
  setStatus(
    state === "denied" ? "error" : "booting",
    state === "denied"
      ? t("statusMicrophoneBlocked")
      : t("statusMicrophoneSetup"),
  );
}

function showCapturePermissionState(granted: boolean): void {
  capturePermissionGranted = granted;
  renderSetupView();
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
  if (isQuietMode) return;
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
        ? t("chromeSummarizer")
        : model === "translator"
          ? t("chromeTranslator")
        : model === "rewriter"
          ? t("chromeRewriter")
          : t("geminiNano");
  }
  if (progressKind === "premium-tts") {
    premiumProgressLabel.textContent = file
      ? t(
          "kokoroFileProgress",
          file.split("/").at(-1) ?? t("modelFile"),
        )
      : t("kokoroVoiceModel");
  }
  if (progressKind === "premium-stt") {
    premiumSttProgressLabel.textContent = file
      ? t(
          "speechFileProgress",
          file.split("/").at(-1) ?? t("modelFile"),
        )
      : t("highAccuracySpeechModel");
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
      ? t(
          "downloadProgressMegabytes",
          formatMegabytes(loaded),
          formatMegabytes(total),
        )
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

function formatBytes(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`;
  const units = ["KB", "MB", "GB"] as const;
  let value = bytes / 1_000;
  let unit: typeof units[number] = units[0];
  for (let index = 1; index < units.length && value >= 1_000; index += 1) {
    value /= 1_000;
    unit = units[index]!;
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits).replace(/\.0+$/, "")} ${unit}`;
}

async function runModelAction(
  row: PanelModelRow,
  action: "download-model" | "delete-model",
  button: HTMLButtonElement,
): Promise<void> {
  button.disabled = true;
  const previousText = button.textContent;
  button.textContent = action === "download-model"
    ? t("startingEllipsis")
    : t("deletingEllipsis");
  try {
    await requestWorker({ type: action, modelId: row.id });
  } catch (error) {
    button.disabled = false;
    button.textContent = previousText;
    appendLog(
      t("logModelStorage"),
      error instanceof Error ? error.message : t("modelTaskFailed"),
      undefined,
      true,
      action === "download-model" ? "download-failure" : undefined,
    );
  }
}

function renderModelInventory(
  rows: readonly PanelModelRow[],
  totalBytes: number,
): void {
  modelsTotal.value = t("modelsTotal", formatBytes(totalBytes));
  modelsTotal.textContent = modelsTotal.value;
  modelsList.replaceChildren(
    ...rows.map((row) => {
      const item = document.createElement("li");
      const main = document.createElement("div");
      const name = document.createElement("span");
      const meta = document.createElement("div");
      const state = document.createElement("span");
      const size = document.createElement("span");
      const detail = document.createElement("span");
      const actions = document.createElement("div");

      item.className = "model-row";
      item.dataset.readOnly = String(row.readOnly);
      main.className = "model-main";
      name.className = "model-name";
      name.textContent = row.label;
      meta.className = "model-meta";
      state.className = "model-state";
      state.dataset.state = row.state;
      state.textContent = MODEL_STATE_LABELS[row.state];
      meta.append(state);
      if (row.bytes !== undefined) {
        size.className = "model-size";
        size.textContent = formatBytes(row.bytes);
        meta.append(size);
      }
      if (row.detail) {
        detail.className = "model-detail";
        detail.textContent = row.detail;
        meta.append(detail);
      }
      main.append(name, meta);
      actions.className = "model-actions";

      if (row.canDownload) {
        const button = document.createElement("button");
        button.className = "button model-action";
        button.type = "button";
        button.textContent = t("download");
        button.setAttribute("aria-label", t("downloadNamed", row.label));
        button.addEventListener("click", () => {
          void runModelAction(row, "download-model", button);
        });
        actions.append(button);
      }
      if (row.canDelete) {
        const button = document.createElement("button");
        button.className = "button model-action";
        button.type = "button";
        button.textContent = t("delete");
        button.setAttribute("aria-label", t("deleteNamed", row.label));
        button.addEventListener("click", () => {
          void runModelAction(row, "delete-model", button);
        });
        actions.append(button);
      }
      item.append(main, actions);
      return item;
    }),
  );
}

const MODEL_STATE_LABELS: Readonly<Record<PanelModelState, string>> = {
  active: t("modelStateActive"),
  cached: t("modelStateCached"),
  absent: t("modelStateAbsent"),
  downloading: t("modelStateDownloading"),
};

const PREMIUM_VOICE_STATE_LABELS: Readonly<Record<PremiumTtsState, string>> = {
  absent: t("stateAbsent"),
  downloading: t("stateDownloading"),
  ready: t("stateReady"),
  error: t("stateError"),
};

function showPremiumVoiceState(
  state: PremiumTtsState,
  enabled: boolean,
  voice: KokoroVoiceId,
  backend?: "webgpu" | "wasm",
  error?: string,
): void {
  premiumState = state;
  premiumSetupVoiceState = state;
  selectedPremiumVoice = voice;
  premiumVoiceCard.dataset.state = state;
  premiumVoiceState.textContent = PREMIUM_VOICE_STATE_LABELS[state];
  premiumVoiceEnabled.checked = enabled;
  premiumVoiceEnabled.disabled = state !== "ready";
  premiumVoicePicker.hidden = state !== "ready";
  premiumVoicePicker.disabled =
    state !== "ready" || premiumVoicePreviewPending;
  selectPremiumVoiceInput(voice);
  downloadPremiumVoice.hidden = state === "ready";
  downloadPremiumVoice.disabled = state === "downloading";

  switch (state) {
    case "absent":
      downloadPremiumVoice.textContent = t("downloadPremiumVoice");
      premiumVoiceCopy.textContent = t("premiumVoiceAbsentCopy");
      break;
    case "downloading":
      downloadPremiumVoice.hidden = false;
      downloadPremiumVoice.textContent = t("downloadingOnDevice");
      premiumProgressCard.hidden = false;
      premiumVoiceCopy.textContent = t("premiumVoiceDownloadingCopy");
      break;
    case "ready":
      {
        const selected = KOKORO_VOICES.find(
          (catalogVoice) => catalogVoice.id === voice,
        );
        const label = selected?.label ?? t("premiumVoice");
        premiumVoiceCopy.textContent = backend
          ? t("premiumVoiceReadyWithBackend", label, backend.toUpperCase())
          : t("premiumVoiceReady", label);
      }
      break;
    case "error":
      downloadPremiumVoice.textContent = t("retryVoiceDownload");
      renderRecoveryMessage(
        premiumVoiceCopy,
        error ?? t("premiumVoiceDownloadFailed"),
        "download-failure",
      );
      break;
  }
  renderSetupView();
}

const PREMIUM_SPEECH_STATE_LABELS: Readonly<
  Record<PremiumSttState, string>
> = {
  "not-downloaded": t("stateNotDownloaded"),
  downloading: t("stateDownloading"),
  validating: t("stateValidating"),
  loading: t("stateLoading"),
  warming: t("stateWarming"),
  ready: t("stateReady"),
  active: t("stateActive"),
  error: t("stateError"),
};

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
  premiumSetupSpeechState = state;
  highAccuracyTier = tier;
  highAccuracyResumable = resumable;
  premiumSttCard.dataset.state = state;
  premiumSttState.textContent = PREMIUM_SPEECH_STATE_LABELS[state];
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
    ? t("parakeetModelCopy")
    : t("moonshineBaseModelCopy");

  switch (state) {
    case "not-downloaded":
      downloadPremiumStt.hidden = false;
      downloadPremiumStt.disabled = false;
      downloadPremiumStt.textContent = resumable
        ? t("resumeDownload")
        : tier === "parakeet"
          ? t("download409Model")
          : t("download63Model");
      premiumSttCopy.textContent = t("premiumSpeechAbsentCopy", modelCopy);
      break;
    case "downloading":
      downloadPremiumStt.hidden = false;
      downloadPremiumStt.textContent = t("downloadingOnDevice");
      premiumSttProgressCard.hidden = false;
      premiumSttCopy.textContent = t(
        "premiumSpeechDownloadingCopy",
        modelCopy,
      );
      break;
    case "validating":
      downloadPremiumStt.hidden = false;
      downloadPremiumStt.textContent = t("validatingPinnedFiles");
      premiumSttProgressCard.hidden = false;
      premiumSttCopy.textContent = t("premiumSpeechValidatingCopy");
      break;
    case "loading":
      downloadPremiumStt.hidden = false;
      downloadPremiumStt.textContent = t("loadingLocalModel");
      premiumSttCopy.textContent = t("premiumSpeechLoadingCopy");
      break;
    case "warming":
      downloadPremiumStt.hidden = false;
      downloadPremiumStt.textContent = t("runningHardwareCheck");
      premiumSttCopy.textContent = t("premiumSpeechWarmingCopy");
      break;
    case "ready":
      premiumSttCopy.textContent = t("premiumSpeechReadyCopy", modelCopy);
      break;
    case "active":
      premiumSttCopy.textContent = resident
        ? t("premiumSpeechActiveCopy", modelCopy)
        : t("premiumSpeechActiveReloadCopy", modelCopy);
      break;
    case "error":
      downloadPremiumStt.hidden = false;
      downloadPremiumStt.disabled = false;
      downloadPremiumStt.textContent = resumable
        ? t("resumeDownload")
        : t("retryHighAccuracySetup");
      const message = resumable
          ? t("premiumSpeechDownloadStopped")
          : error ?? t("premiumSpeechStartFailed");
      renderRecoveryMessage(
        premiumSttCopy,
        message,
        resumable ? "download-failure" : undefined,
      );
      break;
  }
  renderSetupView();
}

function showPageText(text: string, title: string): void {
  pageTextTitle.textContent = title;
  pageTextOutput.textContent = text;
  pageTextCard.hidden = false;
}

function renderStorageCount(
  element: HTMLElement,
  count: number,
  maximum: number,
): void {
  element.textContent = t("storageCount", String(count), String(maximum));
  element.hidden = count <= maximum * 0.8;
}

function renderNoteList(): void {
  renderStorageCount(notesCount, panelNotes.length, MAX_NOTES);
  notesList.replaceChildren();
  const query = notesSearch.value.trim().toLocaleLowerCase();
  const notes = query
    ? panelNotes.filter((note) =>
        note.body.toLocaleLowerCase().includes(query)
      )
    : panelNotes;
  if (notes.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty-notes";
    empty.textContent =
      panelNotes.length === 0 ? t("noNotesYet") : t("noNotesMatch");
    notesList.append(empty);
    exportNotes.disabled = panelNotes.length === 0;
    return;
  }
  exportNotes.disabled = false;
  for (const note of notes) {
    const item = document.createElement("li");
    const body = document.createElement("p");
    const details = document.createElement("div");
    const time = document.createElement("time");
    const deleteButton = document.createElement("button");
    body.textContent = note.body;
    const created = new Date(note.createdAt);
    time.dateTime = note.createdAt;
    time.textContent = Number.isNaN(created.getTime())
      ? t("savedNote")
      : created.toLocaleString([], {
          dateStyle: "medium",
          timeStyle: "short",
        });
    details.className = "note-details";
    deleteButton.className = "note-delete";
    deleteButton.type = "button";
    deleteButton.textContent = t("delete");
    deleteButton.setAttribute(
      "aria-label",
      t("deleteNote", note.body.slice(0, 80)),
    );
    deleteButton.addEventListener("click", async () => {
      deleteButton.disabled = true;
      try {
        const deleted = await requestWorker<boolean>({
          type: "delete-note",
          noteId: note.id,
        });
        if (deleted) {
          panelNotes = panelNotes.filter((item) => item.id !== note.id);
          renderNoteList();
        }
      } catch (error) {
        appendLog(
          t("logDeleteNote"),
          error instanceof Error ? error.message : t("deleteFailed"),
        );
        deleteButton.disabled = false;
      }
    });
    details.append(time, deleteButton);
    item.append(body, details);
    notesList.append(item);
  }
}

function renderNotes(notes: readonly PanelNote[]): void {
  panelNotes = notes;
  renderNoteList();
}

function renderReminderList(): void {
  renderStorageCount(
    remindersCount,
    panelReminders.length,
    MAX_PENDING_REMINDERS,
  );
  remindersList.replaceChildren();
  if (panelReminders.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty-notes";
    empty.textContent = t("noPendingReminders");
    remindersList.append(empty);
    return;
  }

  for (const reminder of panelReminders) {
    const item = document.createElement("li");
    const text = document.createElement("p");
    const details = document.createElement("div");
    const time = document.createElement("time");
    const cancelButton = document.createElement("button");
    const due = new Date(reminder.dueAt);
    text.textContent = reminder.text;
    time.dateTime = reminder.dueAt;
    time.textContent = due.toLocaleString([], {
      dateStyle: "medium",
      timeStyle: "short",
    });
    details.className = "note-details";
    cancelButton.className = "note-delete";
    cancelButton.type = "button";
    cancelButton.textContent = t("cancel");
    cancelButton.setAttribute(
      "aria-label",
      t("cancelReminder", reminder.text.slice(0, 80)),
    );
    cancelButton.addEventListener("click", async () => {
      cancelButton.disabled = true;
      try {
        const cancelled = await requestWorker<boolean>({
          type: "cancel-reminder",
          reminderId: reminder.id,
        });
        if (cancelled) {
          panelReminders = panelReminders.filter(
            (item) => item.id !== reminder.id,
          );
          renderReminderList();
        }
      } catch (error) {
        appendLog(
          t("logCancelReminder"),
          error instanceof Error
            ? error.message
            : t("reminderNotCancelled"),
        );
        cancelButton.disabled = false;
      }
    });
    details.append(time, cancelButton);
    item.append(text, details);
    remindersList.append(item);
  }
}

function renderReminders(reminders: readonly PanelReminder[]): void {
  panelReminders = [...reminders].sort((left, right) =>
    left.dueAt.localeCompare(right.dueAt)
  );
  renderReminderList();
}

function showCommandReference(): void {
  commandReference.open = true;
  commandReference.scrollIntoView({ block: "start" });
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
      ? t("reminderBannerNotificationsOff", reminder.text)
      : t("reminderBanner", reminder.text);
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

const latencyStages: readonly [
  string,
  keyof Pick<
    LatencyStatistics,
    "stt" | "parse" | "act" | "voice" | "total"
  >,
][] = [
  [t("latencySpeechInput"), "stt"],
  [t("latencyParse"), "parse"],
  [t("latencyAct"), "act"],
  [t("latencyVoice"), "voice"],
  [t("latencyTotal"), "total"],
];

function latencyValue(
  stage: LatencyStageStatistics,
  percentile: "p50Ms" | "p95Ms",
): string {
  const value = stage[percentile];
  return value === undefined ? "—" : formatLatencyDuration(value);
}

function renderLatencyStatistics(statistics: LatencyStatistics): void {
  if (
    statistics.sampleCount === 0 ||
    statistics.total.p50Ms === undefined ||
    statistics.total.p95Ms === undefined
  ) {
    latencyReadout.hidden = true;
    latencyDetails.replaceChildren();
    return;
  }

  latencyReadout.hidden = false;
  latencySummary.textContent = t(
    "latencySummary",
    formatLatencyDuration(statistics.total.p50Ms),
    formatLatencyDuration(statistics.total.p95Ms),
    String(statistics.sampleCount),
  );
  latencyDetails.replaceChildren(
    ...latencyStages.map(([label, key]) => {
      const stage = statistics[key];
      const row = document.createElement("tr");
      const name = document.createElement("th");
      const p50 = document.createElement("td");
      const p95 = document.createElement("td");
      const count = document.createElement("td");
      name.scope = "row";
      name.textContent = label;
      p50.textContent = latencyValue(stage, "p50Ms");
      p95.textContent = latencyValue(stage, "p95Ms");
      count.textContent = String(stage.sampleCount);
      row.append(name, p50, p95, count);
      return row;
    }),
  );
}

function actionLogAnnouncement(heard: string, did: string): string {
  const heardText = /[.!?]$/.test(heard) ? heard : `${heard}.`;
  const didText = /[.!?]$/.test(did) ? did : `${did}.`;
  return t("actionLogAnnouncement", heardText, didText);
}

function createSessionHistoryItem(
  entry: SessionHistoryEntry,
): HTMLLIElement {
  const item = document.createElement("li");
  const time = document.createElement("time");
  const copy = document.createElement("p");
  const transcriptText = document.createElement("strong");
  const actionText = document.createElement("span");
  const resultText = document.createElement("span");

  updateLogTime(time, new Date(entry.timestamp));
  transcriptText.textContent = entry.transcript;
  actionText.className = "history-action";
  actionText.textContent = t("historyAction", entry.actionId);
  resultText.textContent = entry.resultLine;
  copy.append(
    transcriptText,
    document.createTextNode(" "),
    actionText,
    document.createTextNode(" "),
    resultText,
  );
  item.append(time, copy);
  return item;
}

function renderSessionHistory(): void {
  if (currentSessionHistory.entries.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty-log";
    empty.textContent = t("noSessionHistory");
    sessionHistoryList.replaceChildren(empty);
    return;
  }
  sessionHistoryList.replaceChildren(
    ...currentSessionHistory.entries
      .slice()
      .reverse()
      .map(createSessionHistoryItem),
  );
}

function showSessionHistory(state: SessionHistoryState): void {
  currentSessionHistory = {
    enabled: state.enabled,
    entries: state.entries.map((entry) => ({ ...entry })),
  };
  sessionHistoryEnabled.checked = state.enabled;
  sessionHistoryPanel.hidden = !state.enabled;
  renderSessionHistory();
}

async function loadSessionHistory(): Promise<void> {
  try {
    const state = await requestWorker<unknown>({
      type: "get-session-history",
    });
    if (!isSessionHistoryState(state)) {
      throw new TypeError("Session history returned an invalid state.");
    }
    showSessionHistory(state);
  } catch {
    showSessionHistory({ enabled: false, entries: [] });
    appendLog(t("history"), t("sessionHistoryUnavailable"));
  }
}

function appendSessionHistory(
  entry: SessionHistoryEntry,
  count: number,
): void {
  if (!currentSessionHistory.enabled) return;
  const expectedCount = Math.min(
    currentSessionHistory.entries.length + 1,
    SESSION_HISTORY_LIMIT,
  );
  if (count !== expectedCount) {
    void loadSessionHistory();
    return;
  }
  currentSessionHistory = {
    enabled: true,
    entries: [...currentSessionHistory.entries, entry].slice(
      -SESSION_HISTORY_LIMIT,
    ),
  };
  renderSessionHistory();
}

function appendLog(
  heard: string,
  did: string,
  timings?: ExchangeTimings,
  announce = true,
  errorClass?: RecoveryErrorClass,
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
        actionLogAnnouncer.textContent = t(
          "actionLogRepeated",
          actionLogAnnouncement(heard, did),
          String(decision.entry.count),
        );
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
    document.createTextNode(t("actionLogEntry", did)),
    count,
  );
  const hint = errorClass ? recoveryHint(errorClass) : undefined;
  if (hint) {
    const hintLine = document.createElement("span");
    hintLine.className = "recovery-hint";
    hintLine.textContent = hint;
    copy.append(hintLine);
  }
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
    throw new Error(response.error?.message ?? t("extensionRequestFailed"));
  }
  return response?.value;
}

async function send(message: Record<string, unknown>): Promise<boolean> {
  try {
    await requestWorker(message);
    return true;
  } catch (error) {
    const detail = error instanceof Error
      ? error.message
      : t("extensionWorkerUnavailable");
    setStatus("error", t("statusNeedsAttention"));
    appendLog(t("logSystem"), detail);
    return false;
  }
}

async function startListening(): Promise<void> {
  if (isListening) return;
  setListening(true);
  if (!(await send({ type: "start-listening" }))) {
    setListening(false);
    setStatus("error", t("statusNeedsAttention"));
  }
}

async function stopListening(): Promise<void> {
  if (!isListening) return;
  setListening(false);
  if (!(await send({ type: "stop-listening" }))) {
    setListening(true);
    setStatus("error", t("statusNeedsAttention"));
  }
}

listenButton.addEventListener("pointerdown", (event) => {
  if (isDictating) {
    pointerIsDown = false;
    void send({ type: "stop-dictation" });
    return;
  }
  pointerIsDown = true;
  listenButton.setPointerCapture(event.pointerId);
  void startListening();
});

listenButton.addEventListener("pointerup", (event) => {
  if (!pointerIsDown) return;
  pointerIsDown = false;
  listenButton.releasePointerCapture(event.pointerId);
  void stopListening();
});

listenButton.addEventListener("pointercancel", () => {
  if (!pointerIsDown) return;
  pointerIsDown = false;
  void stopListening();
});

listenButton.addEventListener("keydown", (event) => {
  if ((event.key === " " || event.key === "Enter") && !event.repeat && !pointerIsDown) {
    event.preventDefault();
    if (isDictating) {
      void send({ type: "stop-dictation" });
      return;
    }
    void startListening();
  }
});

listenButton.addEventListener("keyup", (event) => {
  if (isDictating) return;
  if (event.key === " " || event.key === "Enter") {
    event.preventDefault();
    void stopListening();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !document.hasFocus()) return;
  event.preventDefault();
  if (isDictating) {
    void send({ type: "stop-dictation" });
    return;
  }
  if (isListening) void stopListening();
  showReadingState(false, false);
  void send({ type: "stop-reading" });
});

resumeDictation.addEventListener("click", () => {
  void send({ type: "resume-dictation" });
});

pauseReading.addEventListener("click", () => {
  void send({
    type: "playback-control",
    operation: isReadingPaused ? "resume" : "pause",
  });
});

skipReading.addEventListener("click", () => {
  void send({ type: "playback-control", operation: "skip" });
});

for (const button of [grantMic, setupGrantMic]) {
  button.addEventListener("click", () => {
    void send({ type: "open-microphone-page" });
  });
}

dismissSetup.addEventListener("click", () => {
  setupDismissed = true;
  renderSetupView();
});

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
  empty.textContent = t("noCommandsYet");
  actionLog.append(empty);
});

sessionHistoryEnabled.addEventListener("change", async () => {
  const previous = currentSessionHistory;
  const requested = sessionHistoryEnabled.checked;
  sessionHistoryEnabled.disabled = true;
  showSessionHistory({
    enabled: requested,
    entries: requested && previous.enabled ? previous.entries : [],
  });
  try {
    const state = await requestWorker<unknown>({
      type: "set-session-history-enabled",
      enabled: requested,
    });
    if (!isSessionHistoryState(state)) {
      throw new TypeError("Session history returned an invalid state.");
    }
    showSessionHistory(state);
  } catch {
    showSessionHistory(previous);
    appendLog(t("history"), t("sessionHistoryUnavailable"));
  } finally {
    sessionHistoryEnabled.disabled = false;
  }
});

clearSessionHistory.addEventListener("click", async () => {
  clearSessionHistory.disabled = true;
  try {
    const state = await requestWorker<unknown>({
      type: "clear-session-history",
    });
    if (!isSessionHistoryState(state) || !state.enabled) {
      throw new TypeError("Session history returned an invalid state.");
    }
    showSessionHistory(state);
  } catch {
    appendLog(t("history"), t("sessionHistoryUnavailable"));
  } finally {
    clearSessionHistory.disabled = false;
  }
});

closePageText.addEventListener("click", () => {
  const stopReading = isReading;
  pageTextCard.hidden = true;
  showReadingState(false, false);
  if (stopReading) {
    void send({ type: "playback-control", operation: "stop" });
  }
});

notesSearch.addEventListener("input", renderNoteList);

function downloadDataUrl(
  filename: string,
  dataUrl: string,
): void {
  const link = document.createElement("a");
  link.href = dataUrl;
  link.download = filename;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
}

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
      throw new Error(t("notesExportInvalid"));
    }
    downloadDataUrl(result.filename, result.dataUrl);
  } catch (error) {
    appendLog(
      t("logExportNotes"),
      error instanceof Error ? error.message : t("exportFailed"),
    );
  } finally {
    exportNotes.disabled = panelNotes.length === 0;
  }
});

function clearSettingsImport(): void {
  pendingSettingsBackup = undefined;
  settingsBackupFile.value = "";
  settingsBackupConfirm.hidden = true;
  confirmSettingsImport.disabled = false;
  cancelSettingsImport.disabled = false;
}

function showSettingsBackupStatus(message: string): void {
  settingsBackupStatus.textContent = message;
}

exportSettingsBackup.addEventListener("click", async () => {
  exportSettingsBackup.disabled = true;
  showSettingsBackupStatus("");
  try {
    const result = await requestWorker<{
      readonly filename: string;
      readonly dataUrl: string;
    }>({ type: "export-settings-backup" });
    if (
      !result ||
      !/^sotto-backup-\d{4}-\d{2}-\d{2}\.json$/.test(result.filename) ||
      !result.dataUrl.startsWith(
        "data:application/json;charset=utf-8,",
      ) ||
      result.dataUrl.length > MAX_SETTINGS_BACKUP_FILE_BYTES * 3 + 100
    ) {
      throw new Error("Backup export returned invalid data");
    }
    downloadDataUrl(result.filename, result.dataUrl);
    showSettingsBackupStatus(t("backupExported"));
  } catch {
    showSettingsBackupStatus(t("backupExportFailed"));
  } finally {
    exportSettingsBackup.disabled = false;
  }
});

chooseSettingsBackup.addEventListener("click", () => {
  clearSettingsImport();
  showSettingsBackupStatus("");
  settingsBackupFile.click();
});

settingsBackupFile.addEventListener("change", async () => {
  pendingSettingsBackup = undefined;
  settingsBackupConfirm.hidden = true;
  showSettingsBackupStatus("");
  const file = settingsBackupFile.files?.[0];
  if (!file) return;
  try {
    if (file.size > MAX_SETTINGS_BACKUP_FILE_BYTES) {
      throw new TypeError("Backup file is too large");
    }
    const backup = await file.text();
    const response = await requestWorker<unknown>({
      type: "preview-settings-import",
      backup,
    });
    if (
      !isRecord(response) ||
      response.valid !== true ||
      !isRecord(response.preview) ||
      typeof response.preview.noteCount !== "number" ||
      !Number.isSafeInteger(response.preview.noteCount) ||
      response.preview.noteCount < 0 ||
      response.preview.noteCount > MAX_NOTES
    ) {
      throw new TypeError("Backup file is invalid");
    }
    pendingSettingsBackup = backup;
    settingsBackupConfirmCopy.textContent = t(
      "importConfirm",
      String(response.preview.noteCount),
    );
    settingsBackupConfirm.hidden = false;
    confirmSettingsImport.focus();
  } catch {
    clearSettingsImport();
    showSettingsBackupStatus(t("invalidBackupFile"));
  }
});

cancelSettingsImport.addEventListener("click", () => {
  clearSettingsImport();
  showSettingsBackupStatus(t("importCanceled"));
  chooseSettingsBackup.focus();
});

confirmSettingsImport.addEventListener("click", async () => {
  const backup = pendingSettingsBackup;
  if (backup === undefined) return;
  confirmSettingsImport.disabled = true;
  cancelSettingsImport.disabled = true;
  showSettingsBackupStatus("");
  try {
    const response = await requestWorker<unknown>({
      type: "import-settings-backup",
      backup,
    });
    if (
      !isRecord(response) ||
      response.valid !== true ||
      !isRecord(response.result) ||
      typeof response.result.addedNoteCount !== "number" ||
      !Number.isSafeInteger(response.result.addedNoteCount) ||
      response.result.addedNoteCount < 0 ||
      response.result.addedNoteCount > MAX_NOTES
    ) {
      throw new TypeError("Backup file is invalid");
    }
    const added = response.result.addedNoteCount;
    clearSettingsImport();
    showSettingsBackupStatus(
      added === 0
        ? t("importCompleteNoNotes")
        : t("importCompleteWithNotes", String(added)),
    );
    await Promise.all([loadSpeechSettings(), loadQuietMode()]);
  } catch (error) {
    clearSettingsImport();
    showSettingsBackupStatus(
      error instanceof TypeError
        ? t("invalidBackupFile")
        : t("importFailed"),
    );
  }
});

async function prepareNanoModel(): Promise<void> {
  setupPrepareNano.disabled = true;
  nanoProgressCard.hidden = false;
  setStatus("booting", t("statusPreparingNano"));

  try {
    if (!("LanguageModel" in globalThis)) {
      throw new Error(t("chromePromptApiAbsent"));
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
    const message = error instanceof Error
      ? error.message
      : t("nanoSetupFailed");
    setStatus("error", t("nanoSetupFailed"));
    appendLog(
      t("logModelSetup"),
      message,
      undefined,
      true,
      "nano-unavailable",
    );
    setupPrepareNano.disabled = false;
  }
}

setupPrepareNano.addEventListener("click", () => void prepareNanoModel());

async function preparePremiumVoiceModel(): Promise<void> {
  showPremiumVoiceState(
    "downloading",
    true,
    selectedPremiumVoice,
  );
  updateProgress("premium-tts", 0, false);
  if (!(await send({ type: "prepare-premium-tts" }))) {
    showPremiumVoiceState(
      "error",
      false,
      selectedPremiumVoice,
      undefined,
      t("premiumVoiceSetupStartFailed"),
    );
  }
}

downloadPremiumVoice.addEventListener(
  "click",
  () => void preparePremiumVoiceModel(),
);

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

for (const slider of [speechRate, speechVolume]) {
  slider.addEventListener("input", () => {
    void saveSpeechSettings();
  });
}

responseVerbosity.addEventListener("change", () => {
  void saveSpeechSettings();
});

blockedSiteForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const hostname = sanitizeHostname(blockedSiteInput.value);
  if (hostname === undefined) {
    showBlockedSitesStatus(t("invalidSiteName"));
    return;
  }
  addBlockedSite.disabled = true;
  showBlockedSitesStatus("");
  try {
    const state = await requestWorker<unknown>({
      type: "add-blocked-site",
      hostname,
    });
    if (!isBlockedSitesState(state)) {
      throw new TypeError("The blocked site list is invalid.");
    }
    blockedSiteInput.value = "";
    showBlockedSites(state);
  } catch {
    showBlockedSitesStatus(t("blockedSitesUnavailable"));
  } finally {
    addBlockedSite.disabled = false;
  }
});

blockCurrentSite.addEventListener("click", async () => {
  blockCurrentSite.disabled = true;
  showBlockedSitesStatus("");
  try {
    const state = await requestWorker<unknown>({
      type: "block-current-site",
    });
    if (!isBlockedSitesState(state)) {
      throw new TypeError("The blocked site list is invalid.");
    }
    showBlockedSites(state);
  } catch {
    showBlockedSitesStatus(t("currentSiteUnavailable"));
    blockCurrentSite.disabled = false;
  }
});

async function preparePremiumSpeechModel(): Promise<void> {
  downloadPremiumStt.disabled = true;
  setupDownloadPremium.disabled = true;
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
      t("premiumSpeechSetupStartFailed"),
    );
  }
}

downloadPremiumStt.addEventListener(
  "click",
  () => void preparePremiumSpeechModel(),
);

setupDownloadPremium.addEventListener("click", () => {
  if (premiumState === "ready") {
    void preparePremiumSpeechModel();
    return;
  }
  void preparePremiumVoiceModel();
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

quietModeToggle.addEventListener("change", async () => {
  const requested = quietModeToggle.checked;
  quietModeToggle.disabled = true;
  try {
    const saved = await requestWorker<unknown>({
      type: "set-quiet-mode",
      enabled: requested,
    });
    if (typeof saved !== "boolean") {
      throw new Error("Quiet mode returned an invalid state.");
    }
    showQuietMode(saved);
  } catch {
    showQuietMode(!requested);
    appendLog(t("logQuietMode"), t("quietModeSaveFailed"));
  } finally {
    quietModeToggle.disabled = false;
  }
});

enableCapture.addEventListener("click", async () => {
  enableCapture.disabled = true;
  try {
    if (!(await requestCapturePermission())) {
      appendLog(
        t("logScreenCapture"),
        t("capturePermissionNotGranted"),
        undefined,
        true,
        "capture-permission",
      );
    }
  } finally {
    enableCapture.disabled = false;
  }
});

function showClipboardWorkflow(workflow: ClipboardWorkflow): void {
  pendingScreenshot = workflow;
  const createUrl = workflow.afterWrite?.followUp?.createUrl;
  copyScreenshot.textContent =
    createUrl === "https://claude.ai/new"
      ? t("copyAndOpenClaude")
      : createUrl === "https://chatgpt.com/"
        ? t("copyAndOpenChatGpt")
        : createUrl === "https://gemini.google.com/app"
          ? t("copyAndOpenGemini")
          : t("copyScreenshot");
  clipboardCopy.textContent = workflow.afterWrite?.followUp
    ? t("copyPngThenOpen")
    : t("copyPngToClipboard");
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
    const message = t("clipboardInactive");
    clipboardCopy.textContent = message;
    appendLog(t("logCopyScreenshot"), message);
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
        const screenQuestion =
          permissionWorkflow.pendingCommand.action === "ask-screen";
        const spoken = screenQuestion
          ? "Screen questions need screen capture permission."
          : "Screenshot needs screen capture permission.";
        appendLog(
          screenQuestion ? t("logScreenQuestion") : t("logScreenshot"),
          spoken,
        );
        await send({ type: "speak", text: spoken });
        return;
      }

      const result = await requestWorker<ActionResult>({
        type: "retry-screenshot",
        command: permissionWorkflow.pendingCommand,
      });
      if (permissionWorkflow.pendingCommand.action === "ask-screen") {
        pendingScreenshotPermission = undefined;
        clipboardCard.hidden = true;
        return;
      }
      if (result?.workflow?.kind !== "clipboard-write") {
        throw new Error(t("screenshotNotReady"));
      }
      await receiveClipboardWorkflow(result.workflow);
      return;
    }

    await completeClipboardWorkflow(clipboardWorkflow!);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : t("clipboardWriteFailed");
    appendLog(t("logCopyScreenshot"), message);
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
      if (message.error) {
        appendLog(
          t("logSystem"),
          message.error,
          undefined,
          true,
          message.mic === "denied"
            ? "mic-permission-denied"
            : undefined,
        );
      }
      break;
    case "premium-tts-state":
      showPremiumVoiceState(
        message.state,
        message.enabled,
        message.voice,
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
    case "model-inventory":
      renderModelInventory(message.rows, message.totalBytes);
      break;
    case "stt-diagnostic":
      showTranscript(message.message, message.diagnostic);
      transcript.dataset.diagnostic = message.diagnostic;
      appendLog(
        t("logSpeechDiagnostic", message.diagnostic),
        message.message,
        undefined,
        true,
        message.diagnostic,
      );
      break;
    case "show-command-reference":
      showCommandReference();
      break;
    case "listening-state":
      setListening(message.listening);
      break;
    case "quiet-mode-state":
      showQuietMode(message.enabled);
      break;
    case "speech-start":
      listeningMark.textContent = isDictating
        ? t("dictation")
        : t("stateSpeech");
      listeningMark.dataset.active = "true";
      micMeter.dataset.state = "speech";
      break;
    case "speech-end":
      if (isListening) {
        listeningMark.textContent = isDictating
          ? t("dictation")
          : t("stateLive");
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
      showPageText(message.text, message.title ?? t("page"));
      break;
    case "rewrite-fallback":
      readingProgress.hidden = true;
      showPageText(message.text, t("rewriteNotInserted"));
      appendLog(
        t("logRewrite"),
        t("rewriteNotInsertedLog"),
      );
      break;
    case "reading-progress":
      if (!isReading || !readingView) break;
      readingProgress.hidden = false;
      readingProgress.max = Math.max(1, message.total);
      readingProgress.value = Math.max(
        0,
        Math.min(readingProgress.max, message.current),
      );
      showActiveReadingSentence({
        charIndex: message.current,
        ...(message.chunkIndex === undefined
          ? {}
          : { chunkIndex: message.chunkIndex }),
        ...(message.chunkCount === undefined
          ? {}
          : { chunkCount: message.chunkCount }),
        ...(message.eventType === undefined
          ? {}
          : { eventType: message.eventType }),
      });
      break;
    case "reading-state":
      showReadingState(message.active, message.paused);
      break;
    case "dictation-state":
      showDictationState(message.active, message.paused);
      break;
    case "notes-updated":
      renderNotes(message.notes);
      break;
    case "reminders-updated":
      renderReminders(message.reminders);
      break;
    case "reminder-fired":
      panelReminders = panelReminders.filter(
        (reminder) => reminder.id !== message.reminder.id,
      );
      renderReminderList();
      showReminder(message.reminder, true);
      break;
    case "reminder-opened":
      showReminder(message.reminder);
      break;
    case "earcon":
      void playEarcon(message.kind);
      break;
    case "action-log":
      appendLog(message.heard, message.did, message.timings);
      break;
    case "session-history-entry":
      appendSessionHistory(message.entry, message.count);
      break;
    case "latency-statistics":
      renderLatencyStatistics(message.statistics);
      break;
    case "screenshot-ready":
      void receiveClipboardWorkflow(message.workflow);
      break;
    case "screenshot-permission-needed":
      pendingScreenshot = undefined;
      pendingScreenshotPermission = message.workflow;
      copyScreenshot.textContent = t("enableScreenCaptureOneTime");
      renderRecoveryMessage(
        clipboardCopy,
        t("captureHostPermission", message.workflow.host),
        "capture-permission",
      );
      clipboardCard.hidden = false;
      break;
    case "pipeline-error":
      setStatus("error", t("statusNeedsAttention"));
      renderRecoveryMessage(
        pipelineError,
        message.message,
        message.errorClass,
      );
      appendLog(
        t("logSystem"),
        message.message,
        undefined,
        false,
        message.errorClass,
      );
      break;
  }
});

async function showAssignedShortcuts(): Promise<void> {
  try {
    const commands = await chrome.commands.getAll();
    const shortcuts = [
      {
        command: "toggle-sotto",
        label: shortcutLabel,
        instruction: t("assignListenShortcut"),
      },
      {
        command: "read-this-page",
        label: readPageShortcutLabel,
        instruction: t("assignReadShortcut"),
      },
    ] as const;
    for (const item of shortcuts) {
      const shortcut =
        commands.find((command) => command.name === item.command)?.shortcut ??
          "";
      item.label.textContent = shortcut || t("unassigned");
      if (!shortcut) {
        appendLog(t("logShortcut"), item.instruction);
      }
    }
  } catch (error) {
    console.warn("Sotto could not read its assigned shortcuts", error);
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
      t("logReminder"),
      error instanceof Error ? error.message : t("reminderUnavailable"),
    );
  }
}

async function loadCommandReference(): Promise<void> {
  const reference = await requestWorker<unknown>({
    type: "get-command-reference",
  });
  if (isCommandReference(reference)) {
    renderCommandReference(reference, commandReferenceList);
  }
}

async function loadLatencyStatistics(): Promise<void> {
  const statistics = await requestWorker<unknown>({
    type: "get-latency-statistics",
  });
  if (isLatencyStatistics(statistics)) {
    renderLatencyStatistics(statistics);
  }
}

showTranscript("");
modelsTotal.value = t("modelsTotal", "0 B");
modelsTotal.textContent = modelsTotal.value;
micMeter.dataset.state = "idle";
micMeterFill.style.transform = "scaleX(0)";
renderSetupView();
void send({ type: "get-status" });
void requestWorker<readonly PanelNote[]>({ type: "get-notes" })
  .then((notes) => {
    if (notes) renderNotes(notes);
  })
  .catch((error: unknown) => {
    appendLog(
      t("logNotes"),
      error instanceof Error ? error.message : t("notesUnavailable"),
    );
  });
void requestWorker<readonly PanelReminder[]>({ type: "get-reminders" })
  .then((reminders) => {
    if (reminders) renderReminders(reminders);
  })
  .catch((error: unknown) => {
    appendLog(
      t("logReminders"),
      error instanceof Error
        ? error.message
        : t("remindersUnavailable"),
    );
  });
void loadCapturePermissionState();
void showAssignedShortcuts();
void showReminderFromLocation();
void loadCommandReference().catch(() => undefined);
void loadLatencyStatistics().catch(() => undefined);
void loadSpeechSettings();
void loadQuietMode();
void loadBlockedSites();
void loadSessionHistory();
