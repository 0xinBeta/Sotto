import { t } from "./panel-i18n.js";

export interface ExchangeTimings {
  readonly input: "voice" | "typed";
  readonly sttMs?: number;
  readonly parseMs?: number;
  readonly actionMs?: number;
  readonly voiceMs?: number;
}

export interface LatencyStageStatistics {
  readonly sampleCount: number;
  readonly p50Ms?: number;
  readonly p95Ms?: number;
}

export interface LatencyStatistics {
  readonly sampleCount: number;
  readonly stt: LatencyStageStatistics;
  readonly parse: LatencyStageStatistics;
  readonly act: LatencyStageStatistics;
  readonly voice: LatencyStageStatistics;
  readonly total: LatencyStageStatistics;
}

export type TimingTone = "green" | "amber" | "red";

export interface TimingDisplay {
  readonly stages: string;
  readonly total: string;
  readonly totalMs: number;
  readonly tone: TimingTone;
}

const MAX_STAGE_DURATION_MS = 10 * 60 * 1_000;
const MAX_TOTAL_DURATION_MS = MAX_STAGE_DURATION_MS * 4;
export const MAX_LATENCY_SAMPLES = 50;

function isBoundedDuration(
  value: unknown,
  maximumDurationMs: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= maximumDurationMs
  );
}

function isStageDuration(value: unknown): value is number {
  return isBoundedDuration(value, MAX_STAGE_DURATION_MS);
}

export function isExchangeTimings(value: unknown): value is ExchangeTimings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const timings = value as Record<string, unknown>;
  return (
    (timings.input === "voice" || timings.input === "typed") &&
    (timings.input === "voice" || timings.sttMs === undefined) &&
    (timings.sttMs === undefined || isStageDuration(timings.sttMs)) &&
    (timings.parseMs === undefined || isStageDuration(timings.parseMs)) &&
    (timings.actionMs === undefined || isStageDuration(timings.actionMs)) &&
    (timings.voiceMs === undefined || isStageDuration(timings.voiceMs))
  );
}

export function nearestRankPercentile(
  samples: readonly number[],
  percentile: number,
): number | undefined {
  if (!Number.isFinite(percentile) || percentile <= 0 || percentile > 100) {
    throw new RangeError("Percentile must be more than 0 and at most 100");
  }
  if (samples.length === 0) return undefined;
  if (samples.some((sample) => !Number.isFinite(sample))) {
    throw new TypeError("Percentile samples must be finite numbers");
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const rank = Math.ceil((percentile / 100) * sorted.length);
  return sorted[rank - 1];
}

function stageStatistics(
  samples: readonly number[],
): LatencyStageStatistics {
  const p50Ms = nearestRankPercentile(samples, 50);
  const p95Ms = nearestRankPercentile(samples, 95);
  return {
    sampleCount: samples.length,
    ...(p50Ms === undefined ? {} : { p50Ms }),
    ...(p95Ms === undefined ? {} : { p95Ms }),
  };
}

function aggregateLatency(
  records: readonly ExchangeTimings[],
): LatencyStatistics {
  const stt: number[] = [];
  const parse: number[] = [];
  const act: number[] = [];
  const voice: number[] = [];
  const total: number[] = [];

  for (const record of records) {
    const durations = [
      record.sttMs,
      record.parseMs,
      record.actionMs,
      record.voiceMs,
    ].filter((duration): duration is number => duration !== undefined);
    if (record.sttMs !== undefined) stt.push(record.sttMs);
    if (record.parseMs !== undefined) parse.push(record.parseMs);
    if (record.actionMs !== undefined) act.push(record.actionMs);
    if (record.voiceMs !== undefined) voice.push(record.voiceMs);
    if (durations.length > 0) {
      total.push(durations.reduce((sum, duration) => sum + duration, 0));
    }
  }

  return {
    sampleCount: records.length,
    stt: stageStatistics(stt),
    parse: stageStatistics(parse),
    act: stageStatistics(act),
    voice: stageStatistics(voice),
    total: stageStatistics(total),
  };
}

export class ExchangeTimingBuffer {
  readonly #records: ExchangeTimings[] = [];
  #nextRecord = 0;

  add(record: ExchangeTimings): void {
    if (this.#records.length < MAX_LATENCY_SAMPLES) {
      this.#records.push({ ...record });
      return;
    }
    this.#records[this.#nextRecord] = { ...record };
    this.#nextRecord = (this.#nextRecord + 1) % MAX_LATENCY_SAMPLES;
  }

  snapshot(): readonly ExchangeTimings[] {
    const records = this.#records.length < MAX_LATENCY_SAMPLES
      ? this.#records
      : [
          ...this.#records.slice(this.#nextRecord),
          ...this.#records.slice(0, this.#nextRecord),
        ];
    return records.map((record) => ({ ...record }));
  }

  statistics(): LatencyStatistics {
    return aggregateLatency(this.snapshot());
  }
}

function isLatencyStageStatistics(
  value: unknown,
  maximumDurationMs: number,
  maximumSamples: number,
): value is LatencyStageStatistics {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const stage = value as Record<string, unknown>;
  const sampleCount = stage.sampleCount;
  const hasPercentiles = stage.p50Ms !== undefined &&
    stage.p95Ms !== undefined;
  return (
    typeof sampleCount === "number" &&
    Number.isInteger(sampleCount) &&
    sampleCount >= 0 &&
    sampleCount <= maximumSamples &&
    (sampleCount === 0) === !hasPercentiles &&
    (
      stage.p50Ms === undefined ||
      isBoundedDuration(stage.p50Ms, maximumDurationMs)
    ) &&
    (
      stage.p95Ms === undefined ||
      (
        isBoundedDuration(stage.p95Ms, maximumDurationMs) &&
        typeof stage.p50Ms === "number" &&
        stage.p95Ms >= stage.p50Ms
      )
    )
  );
}

export function isLatencyStatistics(
  value: unknown,
): value is LatencyStatistics {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const statistics = value as Record<string, unknown>;
  const sampleCount = statistics.sampleCount;
  if (
    typeof sampleCount !== "number" ||
    !Number.isInteger(sampleCount) ||
    sampleCount < 0 ||
    sampleCount > MAX_LATENCY_SAMPLES
  ) {
    return false;
  }
  return (
    isLatencyStageStatistics(
      statistics.stt,
      MAX_STAGE_DURATION_MS,
      sampleCount,
    ) &&
    isLatencyStageStatistics(
      statistics.parse,
      MAX_STAGE_DURATION_MS,
      sampleCount,
    ) &&
    isLatencyStageStatistics(
      statistics.act,
      MAX_STAGE_DURATION_MS,
      sampleCount,
    ) &&
    isLatencyStageStatistics(
      statistics.voice,
      MAX_STAGE_DURATION_MS,
      sampleCount,
    ) &&
    isLatencyStageStatistics(
      statistics.total,
      MAX_TOTAL_DURATION_MS,
      sampleCount,
    )
  );
}

export function timingTone(totalMs: number): TimingTone {
  if (totalMs < 2_000) return "green";
  if (totalMs < 3_500) return "amber";
  return "red";
}

function formatStage(durationMs: number): string {
  return `${Math.round(durationMs)}ms`;
}

function formatTotal(totalMs: number): string {
  return totalMs < 1_000
    ? `${Math.round(totalMs)}ms`
    : `${(totalMs / 1_000).toFixed(1)}s`;
}

export function formatLatencyDuration(durationMs: number): string {
  return formatTotal(durationMs);
}

export function formatExchangeTimings(
  timings: ExchangeTimings,
): TimingDisplay | undefined {
  const durations = [
    timings.sttMs,
    timings.parseMs,
    timings.actionMs,
    timings.voiceMs,
  ].filter((duration): duration is number => duration !== undefined);
  if (durations.length === 0) return undefined;

  const stages: string[] = [];
  if (timings.input === "typed") {
    stages.push(t("timingTyped"));
  } else if (timings.sttMs !== undefined) {
    stages.push(t("timingStt", formatStage(timings.sttMs)));
  }
  if (timings.parseMs !== undefined) {
    stages.push(t("timingParse", formatStage(timings.parseMs)));
  }
  if (timings.actionMs !== undefined) {
    stages.push(t("timingAct", formatStage(timings.actionMs)));
  }
  if (timings.voiceMs !== undefined) {
    stages.push(t("timingVoice", formatStage(timings.voiceMs)));
  }

  const totalMs = durations.reduce((sum, duration) => sum + duration, 0);
  return {
    stages: stages.join(" · "),
    total: t("timingTotal", formatTotal(totalMs)),
    totalMs,
    tone: timingTone(totalMs),
  };
}
