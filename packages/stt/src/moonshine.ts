import {
  env,
  InterruptableStoppingCriteria,
  pipeline,
} from "@huggingface/transformers";

import type {
  SttEngine,
  SttProgress,
  SttProgressCallback,
  SttTranscriptionOptions,
} from "./types.js";

const WASM_ASSET_PATH = "assets/ort-transformers/";

export type MoonshineModel = "tiny" | "base";

export interface MoonshineEngineOptions {
  readonly model?: MoonshineModel;
  readonly backend?: "auto" | "wasm";
}

const MODELS = {
  tiny: {
    id: "onnx-community/moonshine-tiny-ONNX",
    revision: "a6da1241cd305dcd64eab1edbd615f2bb9aabb95",
    dtype: {
      webgpu: {
        encoder_model: "fp32",
        decoder_model_merged: "q4",
      },
      wasm: {
        encoder_model: "fp32",
        decoder_model_merged: "q8",
      },
    },
  },
  base: {
    id: "onnx-community/moonshine-base-ONNX",
    revision: "b1e9b6aae3c3c7298f10c3798393fdf38e8fbbad",
    dtype: {
      webgpu: {
        encoder_model: "fp32",
        decoder_model_merged: "q4",
      },
      wasm: {
        encoder_model: "q8",
        decoder_model_merged: "q8",
      },
    },
  },
} as const;

interface MoonshineOutput {
  readonly text: string;
}

interface MoonshineTranscriber {
  (
    audio: Float32Array,
    options?: {
      readonly max_new_tokens?: number;
      readonly stopping_criteria?: InterruptableStoppingCriteria;
    },
  ): Promise<MoonshineOutput>;
  dispose?: () => void | Promise<void>;
}

interface WebGpuProvider {
  requestAdapter(): Promise<unknown | null>;
}

function getWebGpuProvider(): WebGpuProvider | undefined {
  return (navigator as Navigator & { gpu?: WebGpuProvider }).gpu;
}

export class MoonshineEngine implements SttEngine {
  readonly #progressCallbacks = new Set<SttProgressCallback>();
  readonly #model: MoonshineModel;
  readonly #backend: "auto" | "wasm";
  #transcriber: MoonshineTranscriber | undefined;
  #initPromise: Promise<MoonshineTranscriber> | undefined;
  #generation = 0;

  constructor(options: MoonshineEngineOptions = {}) {
    this.#model = options.model ?? "tiny";
    this.#backend = options.backend ?? "auto";
  }

  async init(onProgress?: SttProgressCallback): Promise<void> {
    if (this.#transcriber) {
      return;
    }

    if (onProgress) {
      this.#progressCallbacks.add(onProgress);
    }

    let pending: Promise<MoonshineTranscriber> | undefined;

    try {
      const generation = this.#generation;

      if (!this.#initPromise) {
        this.#configureRuntime();
        this.#initPromise = this.#createTranscriber();
      }

      pending = this.#initPromise;
      const transcriber = await pending;
      if (generation === this.#generation) {
        this.#transcriber = transcriber;
      }
    } finally {
      if (onProgress) {
        this.#progressCallbacks.delete(onProgress);
      }

      if (this.#initPromise === pending) {
        this.#initPromise = undefined;
      }
    }
  }

  async transcribe(
    audio: Float32Array,
    options: SttTranscriptionOptions = {},
  ): Promise<string> {
    if (!this.#transcriber) {
      throw new Error("MoonshineEngine must be initialized before transcription");
    }

    if (!(audio instanceof Float32Array)) {
      throw new TypeError("Moonshine expects mono 16 kHz audio as a Float32Array");
    }

    for (const sample of audio) {
      if (!Number.isFinite(sample)) {
        throw new TypeError("Moonshine audio contains a non-finite sample");
      }
    }

    if (audio.length === 0) {
      return "";
    }

    options.signal?.throwIfAborted();
    const stoppingCriteria = options.signal
      ? new InterruptableStoppingCriteria()
      : undefined;
    const interrupt = () => stoppingCriteria?.interrupt();
    options.signal?.addEventListener("abort", interrupt, { once: true });
    const durationSeconds = audio.length / 16_000;
    let output: MoonshineOutput;
    try {
      output = await this.#transcriber(audio, {
        max_new_tokens: Math.min(
          96,
          Math.ceil(durationSeconds * 6.5) + 8,
        ),
        ...(stoppingCriteria === undefined
          ? {}
          : { stopping_criteria: stoppingCriteria }),
      });
      options.signal?.throwIfAborted();
    } finally {
      options.signal?.removeEventListener("abort", interrupt);
    }
    if (typeof output?.text !== "string") {
      throw new Error("Moonshine returned an invalid transcription result");
    }

    return output.text.trim();
  }

  async dispose(): Promise<void> {
    this.#generation += 1;
    const pending = this.#initPromise;
    this.#initPromise = undefined;

    const transcriber = this.#transcriber;
    this.#transcriber = undefined;

    const pendingTranscriber = pending
      ? await pending.catch(() => undefined)
      : undefined;

    await transcriber?.dispose?.();
    if (pendingTranscriber && pendingTranscriber !== transcriber) {
      await pendingTranscriber.dispose?.();
    }
  }

  #configureRuntime(): void {
    const wasm = env.backends.onnx.wasm;
    if (!wasm) {
      throw new Error("Transformers.js ONNX WASM backend is unavailable");
    }

    wasm.wasmPaths = chrome.runtime.getURL(WASM_ASSET_PATH);
    wasm.numThreads = 1;
    env.useBrowserCache = true;
  }

  async #createTranscriber(): Promise<MoonshineTranscriber> {
    const adapter = this.#backend === "auto"
      ? await getWebGpuProvider()?.requestAdapter().catch(() => null)
      : null;

    if (adapter) {
      try {
        return await this.#loadPipeline("webgpu");
      } catch (error) {
        console.warn(
          "Moonshine WebGPU failed; falling back to WASM",
          error,
        );
      }
    }

    return this.#loadPipeline("wasm");
  }

  async #loadPipeline(
    device: "webgpu" | "wasm",
  ): Promise<MoonshineTranscriber> {
    const model = MODELS[this.#model];
    const transcriber = await pipeline(
      "automatic-speech-recognition",
      model.id,
      {
        device,
        dtype: model.dtype[device],
        revision: model.revision,
        progress_callback: (progress) => {
          this.#emitProgress(progress as SttProgress);
        },
      },
    );

    return transcriber as unknown as MoonshineTranscriber;
  }

  #emitProgress(progress: SttProgress): void {
    for (const callback of this.#progressCallbacks) {
      try {
        callback(progress);
      } catch (error) {
        console.warn("Moonshine progress callback failed", error);
      }
    }
  }
}
