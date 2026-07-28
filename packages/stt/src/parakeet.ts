import {
  fromUrls,
  type ParakeetModel,
} from "parakeet.js";

import type {
  SttEngine,
  SttProgress,
  SttProgressCallback,
} from "./types.js";

export const PARAKEET_MODEL_ID =
  "efederici/parakeet-tdt-0.6b-v3-onnx-int4";
export const PARAKEET_MODEL_REVISION =
  "9828da0021d81df726b3d5ddb2d6d04354942749";
export const PARAKEET_MODEL_BYTES = 409_225_115;

const MODEL_ROOT =
  `https://huggingface.co/${PARAKEET_MODEL_ID}/resolve/` +
  PARAKEET_MODEL_REVISION;
const CACHE_NAME =
  `sotto-parakeet-${PARAKEET_MODEL_REVISION}`;
const MANIFEST_URL = `${MODEL_ROOT}/.sotto-cache-manifest.json`;
const WASM_ASSET_PATH = "assets/ort-parakeet/";
const CACHE_SIZE_HEADER = "x-sotto-validated-size";

const MODEL_FILES = [
  {
    name: "encoder-model.int4.onnx",
    size: 390_929_172,
  },
  {
    name: "decoder_joint-model.int8.onnx",
    size: 18_202_004,
  },
  {
    name: "vocab.txt",
    size: 93_939,
  },
] as const;

type ModelFileName = typeof MODEL_FILES[number]["name"];

interface ParakeetFactory {
  (config: Parameters<typeof fromUrls>[0]): Promise<ParakeetModel>;
}

export interface ParakeetSttEngineOptions {
  readonly cacheStorage?: CacheStorage;
  readonly fetch?: typeof globalThis.fetch;
  readonly factory?: ParakeetFactory;
  readonly runtimeUrl?: (path: string) => string;
  readonly createObjectUrl?: (blob: Blob) => string;
  readonly revokeObjectUrl?: (url: string) => void;
  readonly runLoad?: <T>(task: () => Promise<T>) => Promise<T>;
  /** Test seam; production uses the pinned sizes above. */
  readonly modelSizes?: Partial<Record<ModelFileName, number>>;
}

function remoteUrl(name: ModelFileName): string {
  return `${MODEL_ROOT}/${name}`;
}

function emitSafely(
  callbacks: ReadonlySet<SttProgressCallback>,
  progress: SttProgress,
): void {
  for (const callback of callbacks) {
    try {
      callback(progress);
    } catch (error) {
      console.warn("Parakeet progress callback failed", error);
    }
  }
}

export class ParakeetSttEngine implements SttEngine {
  readonly #progressCallbacks = new Set<SttProgressCallback>();
  readonly #cacheStorage: CacheStorage;
  readonly #fetch: typeof globalThis.fetch;
  readonly #factory: ParakeetFactory;
  readonly #runtimeUrl: (path: string) => string;
  readonly #createObjectUrl: (blob: Blob) => string;
  readonly #revokeObjectUrl: (url: string) => void;
  readonly #runLoad: <T>(task: () => Promise<T>) => Promise<T>;
  readonly #files: ReadonlyArray<{
    readonly name: ModelFileName;
    readonly size: number;
  }>;
  readonly #totalBytes: number;

  #model: ParakeetModel | undefined;
  #initPromise: Promise<ParakeetModel> | undefined;
  #generation = 0;

  constructor(options: ParakeetSttEngineOptions = {}) {
    this.#cacheStorage = options.cacheStorage ?? caches;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#factory = options.factory ?? fromUrls;
    this.#runtimeUrl = options.runtimeUrl ??
      ((path) => chrome.runtime.getURL(path));
    this.#createObjectUrl = options.createObjectUrl ??
      ((blob) => URL.createObjectURL(blob));
    this.#revokeObjectUrl = options.revokeObjectUrl ??
      ((url) => URL.revokeObjectURL(url));
    this.#runLoad = options.runLoad ?? ((task) => task());
    this.#files = MODEL_FILES.map((file) => ({
      name: file.name,
      size: options.modelSizes?.[file.name] ?? file.size,
    }));
    this.#totalBytes = this.#files.reduce(
      (total, file) => total + file.size,
      0,
    );
  }

  async init(onProgress?: SttProgressCallback): Promise<void> {
    if (this.#model) return;
    if (onProgress) this.#progressCallbacks.add(onProgress);

    let pending: Promise<ParakeetModel> | undefined;
    try {
      const generation = this.#generation;
      if (!this.#initPromise) {
        this.#initPromise = this.#loadModel();
      }
      pending = this.#initPromise;
      const model = await pending;
      if (generation === this.#generation) {
        this.#model = model;
      } else {
        await model.dispose();
      }
    } finally {
      if (onProgress) this.#progressCallbacks.delete(onProgress);
      if (this.#initPromise === pending) this.#initPromise = undefined;
    }
  }

  async transcribe(audio: Float32Array): Promise<string> {
    if (!this.#model) {
      throw new Error("ParakeetSttEngine must be initialized before transcription");
    }
    if (!(audio instanceof Float32Array)) {
      throw new TypeError("Parakeet expects mono 16 kHz audio as a Float32Array");
    }
    for (const sample of audio) {
      if (!Number.isFinite(sample)) {
        throw new TypeError("Parakeet audio contains a non-finite sample");
      }
    }
    if (audio.length === 0) return "";

    const result = await this.#model.transcribe(audio, 16_000, {
      returnTimestamps: false,
      returnConfidences: true,
      enableProfiling: false,
    });
    if (typeof result?.utterance_text !== "string") {
      throw new Error("Parakeet returned an invalid transcription result");
    }
    const maximumTokens = Math.min(
      96,
      Math.ceil(audio.length / 16_000 * 6.5) + 8,
    );
    if (
      Array.isArray(result.tokens) &&
      result.tokens.length > maximumTokens
    ) {
      return "";
    }
    return result.utterance_text.trim();
  }

  async dispose(): Promise<void> {
    this.#generation += 1;
    const pending = this.#initPromise;
    this.#initPromise = undefined;
    const model = this.#model;
    this.#model = undefined;
    const pendingModel = pending ? await pending.catch(() => undefined) : undefined;

    await model?.dispose();
    if (pendingModel && pendingModel !== model) {
      await pendingModel.dispose();
    }
  }

  async #loadModel(): Promise<ParakeetModel> {
    const cache = await this.#ensureCachedFiles();
    const urls = await this.#createLocalUrls(cache);
    this.#emit({ status: "loading", progress: 1 });
    try {
      const model = await this.#runLoad(() =>
        this.#factory({
          encoderUrl: urls["encoder-model.int4.onnx"],
          decoderUrl: urls["decoder_joint-model.int8.onnx"],
          tokenizerUrl: urls["vocab.txt"],
          backend: "webgpu",
          preprocessorBackend: "js",
          wasmPaths: this.#runtimeUrl(WASM_ASSET_PATH),
          cpuThreads: typeof crossOriginIsolated !== "undefined" &&
              crossOriginIsolated
            ? 2
            : 1,
        })
      );
      this.#emit({ status: "ready", progress: 1 });
      return model;
    } finally {
      for (const url of Object.values(urls)) {
        this.#revokeObjectUrl(url);
      }
    }
  }

  async #ensureCachedFiles(): Promise<Cache> {
    await this.#clearStagingCaches();
    const cache = await this.#cacheStorage.open(CACHE_NAME);
    if (await this.#hasValidCommit(cache)) {
      this.#emit({
        status: "validating",
        progress: 1,
        loaded: this.#totalBytes,
        total: this.#totalBytes,
      });
      return cache;
    }

    await this.#clearCommittedFiles(cache);
    const nonce =
      globalThis.crypto?.randomUUID?.() ??
      `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const stagingName = `${CACHE_NAME}-staging-${nonce}`;
    const staging = await this.#cacheStorage.open(stagingName);
    let completedBytes = 0;

    try {
      for (const file of this.#files) {
        await this.#downloadToCache(
          staging,
          remoteUrl(file.name),
          file.name,
          file.size,
          completedBytes,
        );
        completedBytes += file.size;
      }

      this.#emit({
        status: "validating",
        progress: 1,
        loaded: this.#totalBytes,
        total: this.#totalBytes,
      });

      for (const file of this.#files) {
        const url = remoteUrl(file.name);
        const staged = await staging.match(url);
        if (!staged) {
          throw new Error(`Parakeet staging cache lost ${file.name}`);
        }
        await cache.put(url, staged);
      }
      await cache.put(
        MANIFEST_URL,
        new Response(
          JSON.stringify({
            revision: PARAKEET_MODEL_REVISION,
            total: this.#totalBytes,
            files: Object.fromEntries(
              this.#files.map((file) => [file.name, file.size]),
            ),
          }),
          {
            headers: { "content-type": "application/json" },
          },
        ),
      );
      return cache;
    } catch (error) {
      await this.#clearCommittedFiles(cache);
      throw error;
    } finally {
      await this.#cacheStorage.delete(stagingName);
    }
  }

  async #downloadToCache(
    cache: Cache,
    url: string,
    fileName: ModelFileName,
    size: number,
    completedBytes: number,
  ): Promise<void> {
    const response = await this.#fetch(url, { cache: "no-store" });
    if (!response.ok || !response.body) {
      throw new Error(
        `Parakeet download failed for ${fileName} (${response.status})`,
      );
    }

    const declaredLength = Number(response.headers.get("content-length"));
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > 0 &&
      declaredLength !== size
    ) {
      throw new Error(
        `Parakeet ${fileName} size mismatch: expected ${size}, got ${declaredLength}`,
      );
    }

    let loaded = 0;
    const monitored = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform: (chunk, controller) => {
          loaded += chunk.byteLength;
          if (loaded > size) {
            controller.error(
              new Error(
                `Parakeet ${fileName} exceeded its pinned size of ${size} bytes`,
              ),
            );
            return;
          }
          this.#emit({
            status: "downloading",
            file: fileName,
            loaded: completedBytes + loaded,
            total: this.#totalBytes,
            progress: (completedBytes + loaded) / this.#totalBytes,
          });
          controller.enqueue(chunk);
        },
      }),
    );
    const headers = new Headers(response.headers);
    headers.set(CACHE_SIZE_HEADER, String(size));
    headers.set("content-length", String(size));
    await cache.put(
      url,
      new Response(monitored, {
        status: 200,
        headers,
      }),
    );
    if (loaded !== size) {
      await cache.delete(url);
      throw new Error(
        `Parakeet ${fileName} size mismatch: expected ${size}, got ${loaded}`,
      );
    }
  }

  async #hasValidCommit(cache: Cache): Promise<boolean> {
    const manifest = await cache.match(MANIFEST_URL);
    if (!manifest) return false;
    let commit: unknown;
    try {
      commit = await manifest.json();
    } catch {
      return false;
    }
    if (
      typeof commit !== "object" ||
      commit === null ||
      Array.isArray(commit)
    ) {
      return false;
    }
    const record = commit as Record<string, unknown>;
    if (
      record.revision !== PARAKEET_MODEL_REVISION ||
      record.total !== this.#totalBytes ||
      typeof record.files !== "object" ||
      record.files === null ||
      Array.isArray(record.files)
    ) {
      return false;
    }
    const committedFiles = record.files as Record<string, unknown>;
    for (const file of this.#files) {
      if (committedFiles[file.name] !== file.size) return false;
      const response = await cache.match(remoteUrl(file.name));
      if (
        !response ||
        Number(response.headers.get(CACHE_SIZE_HEADER)) !== file.size
      ) {
        return false;
      }
    }
    return true;
  }

  async #clearStagingCaches(): Promise<void> {
    if (typeof this.#cacheStorage.keys !== "function") return;
    const names = await this.#cacheStorage.keys();
    await Promise.all(
      names
        .filter((name) => name.startsWith(`${CACHE_NAME}-staging-`))
        .map((name) => this.#cacheStorage.delete(name)),
    );
  }

  async #createLocalUrls(
    cache: Cache,
  ): Promise<Record<ModelFileName, string>> {
    const entries: Array<readonly [ModelFileName, string]> = [];
    try {
      for (const file of this.#files) {
        const response = await cache.match(remoteUrl(file.name));
        if (!response) {
          throw new Error(`Parakeet cache is missing ${file.name}`);
        }
        const blob = await response.blob();
        if (blob.size !== file.size) {
          await this.#clearCommittedFiles(cache);
          throw new Error(
            `Parakeet cached ${file.name} failed size validation`,
          );
        }
        entries.push([file.name, this.#createObjectUrl(blob)]);
      }
      return Object.fromEntries(entries) as Record<ModelFileName, string>;
    } catch (error) {
      for (const [, url] of entries) {
        this.#revokeObjectUrl(url);
      }
      throw error;
    }
  }

  async #clearCommittedFiles(cache: Cache): Promise<void> {
    await Promise.all([
      cache.delete(MANIFEST_URL),
      ...this.#files.map((file) => cache.delete(remoteUrl(file.name))),
    ]);
  }

  #emit(progress: SttProgress): void {
    emitSafely(this.#progressCallbacks, progress);
  }
}
