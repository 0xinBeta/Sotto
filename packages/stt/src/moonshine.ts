import { env, pipeline } from "@huggingface/transformers";

import type {
  SttEngine,
  SttProgress,
  SttProgressCallback,
} from "./types.js";

const MODEL_ID = "onnx-community/moonshine-tiny-ONNX";
const MODEL_REVISION = "a6da1241cd305dcd64eab1edbd615f2bb9aabb95";
const WASM_ASSET_PATH = "assets/ort-transformers/";

const DTYPE = {
  webgpu: {
    encoder_model: "fp32",
    decoder_model_merged: "q4",
  },
  wasm: {
    encoder_model: "fp32",
    decoder_model_merged: "q8",
  },
} as const;

interface MoonshineOutput {
  readonly text: string;
}

interface MoonshineTranscriber {
  (audio: Float32Array): Promise<MoonshineOutput>;
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
  #transcriber: MoonshineTranscriber | undefined;
  #initPromise: Promise<MoonshineTranscriber> | undefined;
  #generation = 0;

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

  async transcribe(audio: Float32Array): Promise<string> {
    if (!this.#transcriber) {
      throw new Error("MoonshineEngine must be initialized before transcription");
    }

    if (!(audio instanceof Float32Array)) {
      throw new TypeError("Moonshine expects mono 16 kHz audio as a Float32Array");
    }

    if (audio.length === 0) {
      return "";
    }

    const output = await this.#transcriber(audio);
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
    const gpu = getWebGpuProvider();
    const adapter = gpu
      ? await gpu.requestAdapter().catch(() => null)
      : null;

    if (adapter) {
      try {
        return await this.#loadPipeline("webgpu", DTYPE.webgpu);
      } catch (error) {
        console.warn(
          "Moonshine WebGPU failed; falling back to WASM",
          error,
        );
      }
    }

    return this.#loadPipeline("wasm", DTYPE.wasm);
  }

  async #loadPipeline(
    device: "webgpu" | "wasm",
    dtype: typeof DTYPE.webgpu | typeof DTYPE.wasm,
  ): Promise<MoonshineTranscriber> {
    const transcriber = await pipeline(
      "automatic-speech-recognition",
      MODEL_ID,
      {
        device,
        dtype,
        revision: MODEL_REVISION,
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
