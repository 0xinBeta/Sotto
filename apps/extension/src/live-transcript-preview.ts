export const LIVE_TRANSCRIPT_PREVIEW_KEY = "liveTranscriptPreview";
export const LIVE_TRANSCRIPT_PARTIAL_INTERVAL_MS = 1_200;
export const LIVE_TRANSCRIPT_MIN_GROWTH_MS = 600;

const STT_SAMPLE_RATE = 16_000;
const MIN_GROWTH_SAMPLES =
  STT_SAMPLE_RATE * LIVE_TRANSCRIPT_MIN_GROWTH_MS / 1_000;

export function liveTranscriptPreviewEnabled(
  webGpuAvailable: boolean,
  stored: unknown,
): boolean {
  return webGpuAvailable && stored !== false;
}

export interface LiveTranscriptPreviewOptions {
  readonly decode: (
    audio: Float32Array,
    signal: AbortSignal,
  ) => Promise<string> | undefined;
  readonly publish: (text: string, audioSamples: number) => void;
  readonly shouldPublish?: () => boolean;
  readonly now?: () => number;
  readonly onError?: (error: unknown) => void;
}

export class LiveTranscriptPreview {
  readonly #decode: LiveTranscriptPreviewOptions["decode"];
  readonly #publish: LiveTranscriptPreviewOptions["publish"];
  readonly #shouldPublish: () => boolean;
  readonly #now: () => number;
  readonly #onError: (error: unknown) => void;
  readonly #frames: Float32Array[] = [];

  #enabled = false;
  #active = false;
  #samples = 0;
  #lastDecodeSamples = 0;
  #lastDecodeAt = Number.NEGATIVE_INFINITY;
  #generation = 0;
  #controller: AbortController | undefined;

  constructor(options: LiveTranscriptPreviewOptions) {
    this.#decode = options.decode;
    this.#publish = options.publish;
    this.#shouldPublish = options.shouldPublish ?? (() => true);
    this.#now = options.now ?? performance.now.bind(performance);
    this.#onError = options.onError ?? (() => undefined);
  }

  setEnabled(enabled: boolean): void {
    this.#enabled = enabled;
    if (!enabled) this.cancel();
  }

  start(): void {
    this.cancel();
    if (!this.#enabled) return;
    this.#active = true;
    this.#lastDecodeAt = Number.NEGATIVE_INFINITY;
  }

  addFrame(frame: Float32Array): void {
    if (!this.#active || !(frame instanceof Float32Array) || frame.length === 0) {
      return;
    }
    const copy = frame.slice();
    this.#frames.push(copy);
    this.#samples += copy.length;
    this.#tryDecode();
  }

  finish(): void {
    this.cancel();
  }

  cancel(): void {
    this.#active = false;
    this.#generation += 1;
    this.#controller?.abort(
      new DOMException("Partial transcription cancelled", "AbortError"),
    );
    this.#controller = undefined;
    this.#frames.length = 0;
    this.#samples = 0;
    this.#lastDecodeSamples = 0;
  }

  #tryDecode(): void {
    const now = this.#now();
    if (
      this.#samples - this.#lastDecodeSamples < MIN_GROWTH_SAMPLES ||
      now - this.#lastDecodeAt < LIVE_TRANSCRIPT_PARTIAL_INTERVAL_MS
    ) {
      return;
    }

    const audio = new Float32Array(this.#samples);
    let offset = 0;
    for (const frame of this.#frames) {
      audio.set(frame, offset);
      offset += frame.length;
    }

    const controller = new AbortController();
    const generation = this.#generation;
    const pending = this.#decode(audio, controller.signal);
    if (!pending) return;

    this.#controller = controller;
    this.#lastDecodeAt = now;
    this.#lastDecodeSamples = this.#samples;
    void pending
      .then((text) => {
        if (
          !controller.signal.aborted &&
          this.#active &&
          this.#generation === generation &&
          this.#shouldPublish()
        ) {
          this.#publish(text, audio.length);
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) this.#onError(error);
      })
      .finally(() => {
        if (this.#controller === controller) this.#controller = undefined;
      });
  }
}
