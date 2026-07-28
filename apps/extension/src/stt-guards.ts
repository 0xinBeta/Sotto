export const STT_SAMPLE_RATE = 16_000;
export const STT_MIN_RMS = 0.003;
export const STT_VOICED_FRAME_RMS = 0.005;
export const STT_MIN_VOICED_MS = 300;
export const STT_TRANSCRIBE_TIMEOUT_MS = 8_000;

const ANALYSIS_FRAME_SAMPLES = 320;
const VAD_FRAME_SAMPLES = 512;
const NORMAL_PRE_ROLL_FRAMES = 8;
const RETRY_PRE_ROLL_FRAMES = 16;
const RETRY_POST_ROLL_FRAMES = 8;
const RETRY_POST_ROLL_MS = 256;

export type SttDiagnostic =
  | "vad-rejected"
  | "blank-result"
  | "timeout"
  | "webgpu-failed";

export type GuardedTranscription =
  | { readonly ok: true; readonly text: string; readonly retried: boolean }
  | {
      readonly ok: false;
      readonly diagnostic: SttDiagnostic;
      readonly retried: boolean;
    };

export interface SttAcousticAssessment {
  readonly accepted: boolean;
  readonly strongEvidence: boolean;
  readonly rms: number;
  readonly voicedMs: number;
}

export interface GuardedTranscriptionOptions {
  readonly audio: Float32Array;
  readonly transcribe: (audio: Float32Array) => Promise<string>;
  readonly expandedAudio?: () => Promise<Float32Array>;
  readonly timeoutMs?: number;
}

export interface SpeechRetryAudio {
  readonly audio: Float32Array;
  expanded(): Promise<Float32Array>;
}

function rmsOf(
  audio: Float32Array,
  start = 0,
  end = audio.length,
): number {
  if (end <= start) return 0;
  let sum = 0;
  for (let index = start; index < end; index += 1) {
    const sample = audio[index] ?? 0;
    sum += sample * sample;
  }
  return Math.sqrt(sum / (end - start));
}

export function assessSttAudio(
  audio: Float32Array,
): SttAcousticAssessment {
  if (!(audio instanceof Float32Array) || audio.length === 0) {
    return { accepted: false, strongEvidence: false, rms: 0, voicedMs: 0 };
  }
  for (const sample of audio) {
    if (!Number.isFinite(sample)) {
      return {
        accepted: false,
        strongEvidence: false,
        rms: Number.NaN,
        voicedMs: 0,
      };
    }
  }

  const rms = rmsOf(audio);
  let voicedFrames = 0;
  for (
    let start = 0;
    start < audio.length;
    start += ANALYSIS_FRAME_SAMPLES
  ) {
    const end = Math.min(audio.length, start + ANALYSIS_FRAME_SAMPLES);
    if (rmsOf(audio, start, end) >= STT_VOICED_FRAME_RMS) {
      voicedFrames += 1;
    }
  }
  const voicedMs =
    voicedFrames * ANALYSIS_FRAME_SAMPLES / STT_SAMPLE_RATE * 1_000;
  const accepted = rms >= STT_MIN_RMS && voicedMs >= STT_MIN_VOICED_MS;
  return {
    accepted,
    strongEvidence: accepted &&
      rms >= STT_VOICED_FRAME_RMS * 1.5 &&
      voicedMs >= 320,
    rms,
    voicedMs,
  };
}

export function sttTokenLimit(durationSeconds: number): number {
  return Math.min(96, Math.ceil(Math.max(0, durationSeconds) * 6.5) + 8);
}

function transcriptTokens(text: string): string[] {
  return text
    .toLocaleLowerCase()
    .match(/[\p{L}\p{N}]+(?:['’_-][\p{L}\p{N}]+)*/gu) ?? [];
}

export function hasRepeatedNgram(text: string): boolean {
  const tokens = transcriptTokens(text);
  for (let width = 2; width <= 4; width += 1) {
    const counts = new Map<string, number>();
    for (let start = 0; start + width <= tokens.length; start += 1) {
      const gram = tokens.slice(start, start + width).join("\u0000");
      counts.set(gram, (counts.get(gram) ?? 0) + 1);
    }
    for (const count of counts.values()) {
      const minimumRepeats = width === 2 ? 3 : 2;
      if (
        count >= minimumRepeats &&
        count * width >= Math.max(6, Math.ceil(tokens.length * 0.6))
      ) {
        return true;
      }
    }
  }
  return false;
}

export function isPlausibleSttText(
  text: string,
  audioSamples: number,
): boolean {
  const normalized = text.trim();
  if (!normalized || !/[\p{L}\p{N}]/u.test(normalized)) return false;
  const tokens = transcriptTokens(normalized);
  const durationSeconds = audioSamples / STT_SAMPLE_RATE;
  return (
    tokens.length > 0 &&
    tokens.length <= sttTokenLimit(durationSeconds) &&
    !hasRepeatedNgram(normalized)
  );
}

export function isWebGpuSttFailure(error: unknown): boolean {
  const detail = error instanceof Error ? error.message : String(error);
  return /device[\s_-]*lost|out of memory|\boom\b|allocation|webgpu|gpu process/i
    .test(detail);
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new DOMException("STT inference timed out", "TimeoutError")),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function transcribeOnce(
  audio: Float32Array,
  options: GuardedTranscriptionOptions,
): Promise<string> {
  return withTimeout(
    options.transcribe(audio),
    options.timeoutMs ?? STT_TRANSCRIBE_TIMEOUT_MS,
  );
}

export async function transcribeWithSttGuards(
  options: GuardedTranscriptionOptions,
): Promise<GuardedTranscription> {
  const assessment = assessSttAudio(options.audio);
  if (!assessment.accepted) {
    return { ok: false, diagnostic: "vad-rejected", retried: false };
  }

  try {
    const first = await transcribeOnce(options.audio, options);
    if (isPlausibleSttText(first, options.audio.length)) {
      return { ok: true, text: first.trim(), retried: false };
    }
    if (!first.trim() && assessment.strongEvidence && options.expandedAudio) {
      const expanded = await options.expandedAudio();
      if (expanded.length > options.audio.length) {
        const expandedAssessment = assessSttAudio(expanded);
        if (expandedAssessment.accepted) {
          const retry = await transcribeOnce(expanded, options);
          if (isPlausibleSttText(retry, expanded.length)) {
            return { ok: true, text: retry.trim(), retried: true };
          }
        }
        return { ok: false, diagnostic: "blank-result", retried: true };
      }
    }
    return { ok: false, diagnostic: "blank-result", retried: false };
  } catch (error) {
    if (
      error instanceof DOMException &&
      error.name === "TimeoutError"
    ) {
      return { ok: false, diagnostic: "timeout", retried: false };
    }
    if (isWebGpuSttFailure(error)) {
      return { ok: false, diagnostic: "webgpu-failed", retried: false };
    }
    throw error;
  }
}

function concatenateFrames(
  frames: readonly Float32Array[],
  middle: Float32Array,
  tail: readonly Float32Array[],
): Float32Array {
  const total = frames.reduce((sum, frame) => sum + frame.length, 0) +
    middle.length +
    tail.reduce((sum, frame) => sum + frame.length, 0);
  const result = new Float32Array(total);
  let offset = 0;
  for (const frame of frames) {
    result.set(frame, offset);
    offset += frame.length;
  }
  result.set(middle, offset);
  offset += middle.length;
  for (const frame of tail) {
    result.set(frame, offset);
    offset += frame.length;
  }
  return result;
}

interface PendingTail {
  readonly frames: Float32Array[];
  readonly done: Promise<void>;
  resolve(): void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export class SpeechContextRing {
  readonly #ring: Float32Array[] = [];
  #preSpeech: Float32Array[] = [];
  #pending: PendingTail | undefined;

  onFrame(frame: Float32Array): void {
    if (!(frame instanceof Float32Array) || frame.length !== VAD_FRAME_SAMPLES) {
      return;
    }
    const copy = frame.slice();
    const pending = this.#pending;
    if (pending && pending.frames.length < RETRY_POST_ROLL_FRAMES) {
      pending.frames.push(copy);
      if (pending.frames.length === RETRY_POST_ROLL_FRAMES) {
        this.#finishPending(pending);
      }
    }
    this.#ring.push(copy);
    while (this.#ring.length > RETRY_PRE_ROLL_FRAMES + 1) {
      this.#ring.shift();
    }
  }

  onSpeechStart(): void {
    if (this.#pending) this.#finishPending(this.#pending);
    this.#preSpeech = this.#ring
      .slice(0, -1)
      .slice(-RETRY_PRE_ROLL_FRAMES);
  }

  onSpeechEnd(audio: Float32Array): SpeechRetryAudio {
    if (this.#pending) this.#finishPending(this.#pending);
    const extraPrefixCount = Math.max(
      0,
      this.#preSpeech.length - NORMAL_PRE_ROLL_FRAMES,
    );
    const extraPrefix = this.#preSpeech
      .slice(0, extraPrefixCount)
      .map((frame) => frame.slice());
    let resolve!: () => void;
    const pending: PendingTail = {
      frames: [],
      done: new Promise<void>((done) => {
        resolve = done;
      }),
      resolve: () => resolve(),
      timer: undefined,
    };
    pending.timer = setTimeout(
      () => this.#finishPending(pending),
      RETRY_POST_ROLL_MS,
    );
    this.#pending = pending;
    this.#preSpeech = [];

    return {
      audio,
      expanded: async () => {
        await pending.done;
        return concatenateFrames(extraPrefix, audio, pending.frames);
      },
    };
  }

  onVADMisfire(): void {
    this.#preSpeech = [];
  }

  dispose(): void {
    if (this.#pending) this.#finishPending(this.#pending);
    this.#ring.splice(0);
    this.#preSpeech = [];
  }

  #finishPending(pending: PendingTail): void {
    if (pending.timer !== undefined) {
      clearTimeout(pending.timer);
      pending.timer = undefined;
    }
    pending.resolve();
    if (this.#pending === pending) this.#pending = undefined;
  }
}
