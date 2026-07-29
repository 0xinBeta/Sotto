import { ort } from "@ricky0123/vad-web/dist/real-time-vad.js";

import type { WakeWordRuntimeState } from "./wake-word-settings.js";
import type { WakeWordModelBytes } from "./wake-word-models.js";

export { WAKE_WORD_MODEL_ASSETS } from "./wake-word-models.js";

export const WAKE_WORD_FRAME_SAMPLES = 1_280;
export const WAKE_WORD_SAMPLE_RATE = 16_000;
export const WAKE_WORD_THRESHOLD = 0.7;
export const WAKE_WORD_NO_SPEECH_TIMEOUT_MS = 4_000;

interface WakeTensor {
  readonly data: unknown;
}

interface WakeInferenceSession {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, WakeTensor>>;
  release(): Promise<void>;
}

type TensorFactory = (
  data: Float32Array,
  dimensions: readonly number[],
) => unknown;

export interface WakeFrameModel {
  processFrame(frame: Float32Array): Promise<number>;
  reset(): void;
  dispose(): Promise<void>;
}

export interface WakeAudioCapture {
  start(onFrame: (frame: Float32Array) => void): Promise<void>;
  stop(): Promise<void>;
}

interface OpenWakeWordModelOptions {
  readonly melspectrogram: WakeInferenceSession;
  readonly embedding: WakeInferenceSession;
  readonly classifier: WakeInferenceSession;
  readonly createTensor: TensorFactory;
}

const MEL_BINS = 32;
const MEL_WINDOW_FRAMES = 76;
const EMBEDDING_FEATURES = 96;
const CLASSIFIER_WINDOW_FRAMES = 16;
const STREAMING_MEL_OVERLAP_SAMPLES = 160 * 3;

function outputData(
  outputs: Record<string, WakeTensor>,
  name: string,
): ArrayLike<number> {
  const tensor = outputs[name];
  if (!tensor) throw new Error(`The wake model has no ${name} output`);
  const data = tensor.data;
  if (
    typeof data !== "object" ||
    data === null ||
    !("length" in data)
  ) {
    throw new Error(`The wake model ${name} output is not an array`);
  }
  return data as ArrayLike<number>;
}

/**
 * This class owns the complete audio-data boundary for wake detection.
 * Raw frames enter processFrame and go only to the three wake model graphs.
 */
export class OpenWakeWordModel implements WakeFrameModel {
  readonly #melspectrogram: WakeInferenceSession;
  readonly #embedding: WakeInferenceSession;
  readonly #classifier: WakeInferenceSession;
  readonly #createTensor: TensorFactory;
  #melWindow = new Float32Array(MEL_WINDOW_FRAMES * MEL_BINS);
  #embeddingWindow = new Float32Array(
    CLASSIFIER_WINDOW_FRAMES * EMBEDDING_FEATURES,
  );
  #audioOverlap = new Float32Array(0);

  constructor(options: OpenWakeWordModelOptions) {
    this.#melspectrogram = options.melspectrogram;
    this.#embedding = options.embedding;
    this.#classifier = options.classifier;
    this.#createTensor = options.createTensor;
    this.reset();
  }

  static async create(
    modelFiles: WakeWordModelBytes,
  ): Promise<OpenWakeWordModel> {
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    ort.env.wasm.wasmPaths = chrome.runtime.getURL("assets/ort-kokoro/");

    const sessionOptions = {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    } as const;
    const [melspectrogram, embedding, classifier] = await Promise.all([
      ort.InferenceSession.create(
        modelFiles.melspectrogram,
        sessionOptions,
      ),
      ort.InferenceSession.create(
        modelFiles.embedding,
        sessionOptions,
      ),
      ort.InferenceSession.create(
        modelFiles.classifier,
        sessionOptions,
      ),
    ]);
    return new OpenWakeWordModel({
      melspectrogram,
      embedding,
      classifier,
      createTensor: (data, dimensions) =>
        new ort.Tensor("float32", data, [...dimensions]),
    });
  }

  reset(): void {
    this.#melWindow = new Float32Array(MEL_WINDOW_FRAMES * MEL_BINS);
    this.#melWindow.fill(1);
    this.#embeddingWindow = new Float32Array(
      CLASSIFIER_WINDOW_FRAMES * EMBEDDING_FEATURES,
    );
    this.#audioOverlap = new Float32Array(0);
  }

  async processFrame(frame: Float32Array): Promise<number> {
    if (frame.length !== WAKE_WORD_FRAME_SAMPLES) {
      throw new RangeError("A wake audio frame must contain 1,280 samples");
    }

    const audio = new Float32Array(this.#audioOverlap.length + frame.length);
    audio.set(this.#audioOverlap);
    for (let index = 0; index < frame.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, frame[index] ?? 0));
      audio[this.#audioOverlap.length + index] = sample * 32_767;
    }
    const nextOverlap = frame.subarray(
      frame.length - STREAMING_MEL_OVERLAP_SAMPLES,
    );
    this.#audioOverlap = new Float32Array(nextOverlap);

    const melInputName = this.#melspectrogram.inputNames[0]!;
    const melOutputName = this.#melspectrogram.outputNames[0]!;
    const melOutputs = await this.#melspectrogram.run({
      [melInputName]: this.#createTensor(audio, [1, audio.length]),
    });
    const rawMel = outputData(melOutputs, melOutputName);
    if (rawMel.length % MEL_BINS !== 0) {
      throw new Error("The wake mel output has an invalid size");
    }
    const mel = new Float32Array(rawMel.length);
    for (let index = 0; index < rawMel.length; index += 1) {
      mel[index] = (rawMel[index] ?? 0) / 10 + 2;
    }
    this.#appendMelFrames(mel);

    const embeddingInputName = this.#embedding.inputNames[0]!;
    const embeddingOutputName = this.#embedding.outputNames[0]!;
    const embeddingOutputs = await this.#embedding.run({
      [embeddingInputName]: this.#createTensor(
        this.#melWindow,
        [1, MEL_WINDOW_FRAMES, MEL_BINS, 1],
      ),
    });
    const embedding = outputData(
      embeddingOutputs,
      embeddingOutputName,
    );
    if (embedding.length !== EMBEDDING_FEATURES) {
      throw new Error("The wake embedding output has an invalid size");
    }
    this.#embeddingWindow.copyWithin(
      0,
      EMBEDDING_FEATURES,
    );
    this.#embeddingWindow.set(
      Float32Array.from(embedding),
      this.#embeddingWindow.length - EMBEDDING_FEATURES,
    );

    const classifierInputName = this.#classifier.inputNames[0]!;
    const classifierOutputName = this.#classifier.outputNames[0]!;
    const classifierOutputs = await this.#classifier.run({
      [classifierInputName]: this.#createTensor(
        this.#embeddingWindow,
        [1, CLASSIFIER_WINDOW_FRAMES, EMBEDDING_FEATURES],
      ),
    });
    const score = outputData(
      classifierOutputs,
      classifierOutputName,
    )[0];
    return typeof score === "number" && Number.isFinite(score) ? score : 0;
  }

  async dispose(): Promise<void> {
    this.reset();
    await Promise.all([
      this.#melspectrogram.release(),
      this.#embedding.release(),
      this.#classifier.release(),
    ]);
  }

  #appendMelFrames(mel: Float32Array): void {
    const maximum = this.#melWindow.length;
    if (mel.length >= maximum) {
      this.#melWindow.set(mel.subarray(mel.length - maximum));
      return;
    }
    this.#melWindow.copyWithin(0, mel.length);
    this.#melWindow.set(mel, maximum - mel.length);
  }
}

export class BrowserWakeAudioCapture implements WakeAudioCapture {
  #stream: MediaStream | undefined;
  #context: AudioContext | undefined;
  #source: MediaStreamAudioSourceNode | undefined;
  #worklet: AudioWorkletNode | undefined;

  async start(onFrame: (frame: Float32Array) => void): Promise<void> {
    if (this.#stream) return;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });

    try {
      const context = new AudioContext();
      await context.audioWorklet.addModule(
        chrome.runtime.getURL("assets/vad/vad.worklet.bundle.min.js"),
      );
      const worklet = new AudioWorkletNode(
        context,
        "vad-helper-worklet",
        {
          processorOptions: {
            frameSamples: WAKE_WORD_FRAME_SAMPLES,
          },
        },
      );
      const source = context.createMediaStreamSource(stream);
      worklet.port.onmessage = (event: MessageEvent<unknown>) => {
        const message = event.data;
        if (
          typeof message !== "object" ||
          message === null ||
          !("message" in message) ||
          (message as { message?: unknown }).message !== "AUDIO_FRAME" ||
          !("data" in message) ||
          !((message as { data?: unknown }).data instanceof ArrayBuffer)
        ) {
          return;
        }
        onFrame(
          new Float32Array((message as { data: ArrayBuffer }).data),
        );
      };
      source.connect(worklet);
      await context.resume();
      this.#stream = stream;
      this.#context = context;
      this.#source = source;
      this.#worklet = worklet;
    } catch (error) {
      stream.getTracks().forEach((track) => track.stop());
      throw error;
    }
  }

  async stop(): Promise<void> {
    const stream = this.#stream;
    const context = this.#context;
    const worklet = this.#worklet;
    this.#stream = undefined;
    this.#context = undefined;
    this.#source?.disconnect();
    this.#source = undefined;
    this.#worklet = undefined;
    if (worklet) {
      worklet.port.onmessage = null;
      worklet.port.postMessage("SPEECH_STOP");
      worklet.disconnect();
    }
    stream?.getTracks().forEach((track) => track.stop());
    await context?.close().catch(() => undefined);
  }
}

type WakeSuspension = "session" | "playback";

interface WakeWordControllerOptions {
  readonly createModel: () => Promise<WakeFrameModel>;
  readonly createCapture: () => WakeAudioCapture;
  readonly onDetected: () => Promise<void> | void;
  readonly onStateChange?: (
    enabled: boolean,
    state: WakeWordRuntimeState,
  ) => Promise<void> | void;
  readonly yieldControl?: () => Promise<void>;
  readonly threshold?: number;
}

async function lowPriorityYield(): Promise<void> {
  const scheduling = globalThis as typeof globalThis & {
    readonly scheduler?: { yield?: () => Promise<void> };
  };
  if (scheduling.scheduler?.yield) {
    await scheduling.scheduler.yield();
    return;
  }
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

/**
 * The wake controller never uses the primary inference mutex.
 * It yields before each wake inference and drops frames if inference is late.
 */
export class WakeWordController {
  readonly #options: WakeWordControllerOptions;
  readonly #suspensions = new Set<WakeSuspension>();
  #enabled = false;
  #detected = false;
  #state: WakeWordRuntimeState = "disarmed";
  #model: WakeFrameModel | undefined;
  #capture: WakeAudioCapture | undefined;
  #operation: Promise<void> = Promise.resolve();
  #frameTask: Promise<void> | undefined;
  #modelRun: Promise<number> | undefined;
  #generation = 0;

  constructor(options: WakeWordControllerOptions) {
    this.#options = options;
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  get state(): WakeWordRuntimeState {
    return this.#state;
  }

  setEnabled(enabled: boolean): Promise<void> {
    this.#enabled = enabled;
    if (!enabled) {
      this.#detected = false;
      this.#suspensions.clear();
      this.#generation += 1;
    }
    return this.#enqueue(() => this.#reconcile());
  }

  setSuspended(
    reason: WakeSuspension,
    suspended: boolean,
  ): Promise<void> {
    if (suspended) this.#suspensions.add(reason);
    else this.#suspensions.delete(reason);
    this.#generation += 1;
    return this.#enqueue(() => this.#reconcile());
  }

  resumeAfterDetection(): Promise<void> {
    this.#detected = false;
    this.#generation += 1;
    return this.#enqueue(() => this.#reconcile());
  }

  dispose(): Promise<void> {
    return this.setEnabled(false);
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    const pending = this.#operation
      .catch(() => undefined)
      .then(operation);
    this.#operation = pending;
    return pending;
  }

  async #reconcile(): Promise<void> {
    if (!this.#enabled) {
      await this.#stopCapture();
      await this.#modelRun?.catch(() => undefined);
      const model = this.#model;
      this.#model = undefined;
      await model?.dispose();
      await this.#setState("disarmed");
      return;
    }

    if (this.#detected || this.#suspensions.size > 0) {
      await this.#stopCapture();
      await this.#setState("suspended");
      return;
    }
    if (this.#capture) {
      await this.#setState("armed");
      return;
    }

    const generation = this.#generation;
    await this.#setState("arming");
    try {
      this.#model ??= await this.#options.createModel();
      if (
        generation !== this.#generation ||
        !this.#enabled ||
        this.#detected ||
        this.#suspensions.size > 0
      ) {
        await this.#reconcile();
        return;
      }
      this.#model.reset();
      const capture = this.#options.createCapture();
      await capture.start((frame) => this.#receiveFrame(frame));
      if (
        generation !== this.#generation ||
        !this.#enabled ||
        this.#detected ||
        this.#suspensions.size > 0
      ) {
        await capture.stop();
        await this.#reconcile();
        return;
      }
      this.#capture = capture;
      await this.#setState("armed");
    } catch (error) {
      await this.#stopCapture();
      await this.#setState("error");
      throw error;
    }
  }

  #receiveFrame(frame: Float32Array): void {
    if (
      this.#state !== "armed" ||
      this.#frameTask !== undefined ||
      !this.#model
    ) {
      return;
    }
    const generation = this.#generation;
    const modelRun = (async () => {
      await (this.#options.yieldControl ?? lowPriorityYield)();
      return await this.#model!.processFrame(frame);
    })();
    this.#modelRun = modelRun;
    const task = (async () => {
      const score = await modelRun;
      if (
        generation !== this.#generation ||
        this.#state !== "armed" ||
        score < (this.#options.threshold ?? WAKE_WORD_THRESHOLD)
      ) {
        return;
      }
      this.#detected = true;
      this.#generation += 1;
      const detectionGeneration = this.#generation;
      await this.#enqueue(async () => {
        await this.#stopCapture();
        this.#model?.reset();
        await this.#setState("suspended");
      });
      if (
        !this.#enabled ||
        !this.#detected ||
        detectionGeneration !== this.#generation
      ) {
        return;
      }
      await this.#options.onDetected();
    })()
      .catch(async (error: unknown) => {
        console.warn("Sotto wake inference failed", error);
        this.#generation += 1;
        await this.#enqueue(async () => {
          await this.#stopCapture();
          await this.#setState("error");
        });
      })
      .finally(() => {
        if (this.#modelRun === modelRun) this.#modelRun = undefined;
        if (this.#frameTask === task) this.#frameTask = undefined;
      });
    this.#frameTask = task;
  }

  async #stopCapture(): Promise<void> {
    const capture = this.#capture;
    this.#capture = undefined;
    await capture?.stop();
  }

  async #setState(state: WakeWordRuntimeState): Promise<void> {
    this.#state = state;
    await this.#options.onStateChange?.(this.#enabled, state);
  }
}

export class WakeSpeechConfirmGuard {
  readonly #setTimer: (
    handler: TimerHandler,
    timeout?: number,
  ) => number;
  readonly #clearTimer: (timer: number) => void;
  #timer: number | undefined;

  constructor(
    setTimer: (
      handler: TimerHandler,
      timeout?: number,
    ) => number = (handler, timeout) =>
      globalThis.setTimeout(handler, timeout) as unknown as number,
    clearTimer: (timer: number) => void = (timer) =>
      globalThis.clearTimeout(
        timer as unknown as ReturnType<typeof globalThis.setTimeout>,
      ),
  ) {
    this.#setTimer = setTimer;
    this.#clearTimer = clearTimer;
  }

  begin(onNoSpeech: () => void): void {
    this.cancel();
    this.#timer = this.#setTimer(() => {
      this.#timer = undefined;
      onNoSpeech();
    }, WAKE_WORD_NO_SPEECH_TIMEOUT_MS);
  }

  confirmSpeech(): void {
    this.cancel();
  }

  cancel(): void {
    if (this.#timer === undefined) return;
    this.#clearTimer(this.#timer);
    this.#timer = undefined;
  }
}
