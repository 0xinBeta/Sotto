export interface ExchangeTimings {
  readonly input: "voice" | "typed";
  readonly sttMs?: number;
  readonly parseMs?: number;
  readonly actionMs?: number;
  readonly voiceMs?: number;
}

export type TimingTone = "green" | "amber" | "red";

export interface TimingDisplay {
  readonly stages: string;
  readonly total: string;
  readonly totalMs: number;
  readonly tone: TimingTone;
}

const MAX_STAGE_DURATION_MS = 10 * 60 * 1_000;

function isStageDuration(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= MAX_STAGE_DURATION_MS
  );
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
    stages.push("typed");
  } else if (timings.sttMs !== undefined) {
    stages.push(`stt ${formatStage(timings.sttMs)}`);
  }
  if (timings.parseMs !== undefined) {
    stages.push(`parse ${formatStage(timings.parseMs)}`);
  }
  if (timings.actionMs !== undefined) {
    stages.push(`act ${formatStage(timings.actionMs)}`);
  }
  if (timings.voiceMs !== undefined) {
    stages.push(`voice ${formatStage(timings.voiceMs)}`);
  }

  const totalMs = durations.reduce((sum, duration) => sum + duration, 0);
  return {
    stages: stages.join(" · "),
    total: `total ${formatTotal(totalMs)}`,
    totalMs,
    tone: timingTone(totalMs),
  };
}
