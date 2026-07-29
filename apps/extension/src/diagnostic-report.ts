import type {
  ChromeAvailability,
  ModelId,
  ModelState,
} from "./model-manager.js";
import type {
  PremiumSttState,
} from "./premium-stt.js";
import type { PremiumTtsState } from "./premium-tts.js";
import {
  formatLatencyDuration,
  type LatencyStageStatistics,
  type LatencyStatistics,
} from "./timings.js";

export interface DiagnosticModel {
  readonly id: ModelId;
  readonly state: ModelState;
  readonly bytes?: number;
}

export interface DiagnosticPipelineError {
  readonly timestamp: string;
  readonly message: string;
}

export interface DiagnosticOffscreenState {
  readonly chromeVersion: string;
  readonly platform: string;
  readonly webGpu: boolean;
  readonly models: readonly DiagnosticModel[];
  readonly modelStorageBytes: number;
  readonly sttEngine: "moonshine" | "parakeet";
  readonly sttTier: "tiny" | "base" | "v3";
  readonly sttBackend: "webgpu" | "wasm";
  readonly premiumSttEnabled: boolean;
  readonly premiumSttState: PremiumSttState;
  readonly ttsEngine: "system" | "kokoro";
  readonly premiumTtsEnabled: boolean;
  readonly premiumTtsState: PremiumTtsState;
  readonly premiumTtsVoice: string;
  readonly premiumTtsBackend?: "webgpu" | "wasm";
  readonly nanoAvailability: ChromeAvailability;
  readonly summarizerAvailability: ChromeAvailability;
  readonly micPermission: PermissionState | "unknown";
  readonly wakeWord: "armed" | "disarmed";
}

/**
 * This allowlist is the complete input boundary for diagnostic text.
 * It has no application-content fields.
 */
export interface DiagnosticReportInput extends DiagnosticOffscreenState {
  readonly generatedAt: string;
  readonly extensionVersion: string;
  readonly rate: number;
  readonly volume: number;
  readonly blockedSiteCount: number;
  readonly sessionHistoryEnabled: boolean;
  readonly sessionHistoryCount: number;
  readonly storageBytes: number;
  readonly pipelineErrors: readonly DiagnosticPipelineError[];
  readonly latency: LatencyStatistics;
}

const MAX_MODELS = 40;
const MAX_PIPELINE_ERRORS = 10;
const MAX_ERROR_CHARACTERS = 500;
const URL_PATTERN =
  /\b(?:https?|file|data|chrome|chrome-extension):\/\/[^\s]+/giu;

function isoTimestamp(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toISOString()
    : new Date(0).toISOString();
}

function safeVersion(value: string): string {
  return /^[0-9A-Za-z.+_-]{1,80}$/.test(value) ? value : "unknown";
}

function safePlatform(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return /^[0-9A-Za-z ._()-]{1,100}$/.test(normalized)
    ? normalized
    : "unknown";
}

function safeModelId(id: ModelId): string | undefined {
  if (
    id === "moonshine-tiny" ||
    id === "moonshine-base" ||
    id === "parakeet-v3" ||
    id === "kokoro" ||
    id === "gemini-nano" ||
    id === "summarizer" ||
    /^kokoro-voice:[a-z]{2}_[a-z]+$/.test(id)
  ) {
    return id;
  }
  return undefined;
}

function safeVoice(value: string): string {
  return /^[a-z]{2}_[a-z]+$/.test(value) ? value : "unknown";
}

function onOff(value: boolean): string {
  return value ? "on" : "off";
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

function formatBytes(value: number | undefined): string {
  if (
    value === undefined ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    return "unknown";
  }
  if (value < 1_024) return `${value} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"] as const;
  let amount = value;
  let unit: (typeof units)[number] = units[0];
  for (const nextUnit of units) {
    amount /= 1_024;
    unit = nextUnit;
    if (amount < 1_024 || nextUnit === units.at(-1)) break;
  }
  return `${amount.toFixed(amount >= 10 ? 1 : 2)} ${unit}`;
}

function formatLatencyValue(
  stage: LatencyStageStatistics,
  percentile: "p50Ms" | "p95Ms",
): string {
  const value = stage[percentile];
  return value === undefined ? "—" : formatLatencyDuration(value);
}

export function sanitizePipelineErrorMessage(message: string): string {
  return message
    .replace(URL_PATTERN, "[removed URL]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_ERROR_CHARACTERS);
}

export class PipelineErrorBuffer {
  readonly #entries: DiagnosticPipelineError[] = [];

  add(message: string, timestamp: Date = new Date()): void {
    const safeMessage = sanitizePipelineErrorMessage(message);
    if (!safeMessage) return;
    this.#entries.push({
      timestamp: isoTimestamp(timestamp),
      message: safeMessage,
    });
    if (this.#entries.length > MAX_PIPELINE_ERRORS) {
      this.#entries.splice(
        0,
        this.#entries.length - MAX_PIPELINE_ERRORS,
      );
    }
  }

  snapshot(): readonly DiagnosticPipelineError[] {
    return this.#entries.map((entry) => ({ ...entry }));
  }
}

export function buildDiagnosticReport(
  input: DiagnosticReportInput,
): string {
  const lines = [
    "# Sotto diagnostic report",
    `Generated: ${isoTimestamp(input.generatedAt)}`,
    `Extension version: ${safeVersion(input.extensionVersion)}`,
    "",
    "## Runtime",
    `Chrome version: ${safeVersion(input.chromeVersion)}`,
    `Platform: ${safePlatform(input.platform)}`,
    `WebGPU: ${yesNo(input.webGpu)}`,
    "",
    "## Models",
  ];

  for (const model of input.models.slice(0, MAX_MODELS)) {
    const id = safeModelId(model.id);
    if (!id) continue;
    lines.push(`- ${id}: ${model.state}, ${formatBytes(model.bytes)}`);
  }

  lines.push(
    `Model cache bytes: ${formatBytes(input.modelStorageBytes)}`,
    `Extension storage bytes: ${formatBytes(input.storageBytes)}`,
    "",
    "## Settings",
    `Speech input engine: ${input.sttEngine}`,
    `Speech input tier: ${input.sttTier}`,
    `Speech input backend: ${input.sttBackend}`,
    `Premium speech input: ${onOff(input.premiumSttEnabled)}`,
    `Premium speech input state: ${input.premiumSttState}`,
    `Speech output engine: ${input.ttsEngine}`,
    `Premium speech output: ${onOff(input.premiumTtsEnabled)}`,
    `Premium speech output state: ${input.premiumTtsState}`,
    `Premium voice: ${safeVoice(input.premiumTtsVoice)}`,
    `Premium speech output backend: ${input.premiumTtsBackend ?? "none"}`,
    `Rate: ${input.rate.toFixed(1)}`,
    `Volume: ${Math.round(input.volume * 100)}%`,
    `Blocked sites: ${input.blockedSiteCount}`,
    `Session history: ${input.sessionHistoryEnabled ? "enabled" : "disabled"}`,
    `Session history entries: ${input.sessionHistoryCount}`,
    `Wake phrase "Hey Jarvis": ${input.wakeWord}`,
    "",
    "## Chrome AI",
    `Gemini Nano: ${input.nanoAvailability}`,
    `Summarizer: ${input.summarizerAvailability}`,
    "",
    "## Permissions",
    `Microphone: ${input.micPermission}`,
    "",
    "## Latency",
    `Samples: ${input.latency.sampleCount}`,
    "| Stage | p50 | p95 | Samples |",
    "| --- | ---: | ---: | ---: |",
    `| Speech input | ${formatLatencyValue(input.latency.stt, "p50Ms")} | ${formatLatencyValue(input.latency.stt, "p95Ms")} | ${input.latency.stt.sampleCount} |`,
    `| Parse | ${formatLatencyValue(input.latency.parse, "p50Ms")} | ${formatLatencyValue(input.latency.parse, "p95Ms")} | ${input.latency.parse.sampleCount} |`,
    `| Act | ${formatLatencyValue(input.latency.act, "p50Ms")} | ${formatLatencyValue(input.latency.act, "p95Ms")} | ${input.latency.act.sampleCount} |`,
    `| Voice | ${formatLatencyValue(input.latency.voice, "p50Ms")} | ${formatLatencyValue(input.latency.voice, "p95Ms")} | ${input.latency.voice.sampleCount} |`,
    `| Total | ${formatLatencyValue(input.latency.total, "p50Ms")} | ${formatLatencyValue(input.latency.total, "p95Ms")} | ${input.latency.total.sampleCount} |`,
    "",
    "## Pipeline errors",
  );

  const errors = input.pipelineErrors.slice(-MAX_PIPELINE_ERRORS);
  if (errors.length === 0) {
    lines.push("- None");
  } else {
    for (const error of errors) {
      lines.push(
        `- ${isoTimestamp(error.timestamp)} — ${
          sanitizePipelineErrorMessage(error.message) || "Unknown error"
        }`,
      );
    }
  }

  return lines.slice(0, 120).join("\n");
}
