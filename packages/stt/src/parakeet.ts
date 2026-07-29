import {
  fromUrls,
  type ParakeetModel,
} from "parakeet.js";

import type {
  SttEngine,
  SttProgress,
  SttProgressCallback,
  SttTranscriptionOptions,
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
const STAGING_CACHE_NAME = `${CACHE_NAME}-staging`;
const STAGING_MANIFEST_URL = `${MODEL_ROOT}/.sotto-staging-manifest.json`;
const WASM_ASSET_PATH = "assets/ort-parakeet/";
const CACHE_SIZE_HEADER = "x-sotto-validated-size";
const PARTIAL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const PARTIAL_CHUNK_BYTES = 4 * 1_024 * 1_024;
const DOWNLOAD_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;

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

interface StagedFile {
  size: number;
  offset: number;
  chunks: number;
  complete: boolean;
  rangeSupported?: boolean;
  contentType?: string;
}

interface StagingManifest {
  revision: string;
  total: number;
  updatedAt: number;
  files: Record<ModelFileName, StagedFile>;
}

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
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  /** Test seam; production uses the pinned sizes above. */
  readonly modelSizes?: Partial<Record<ModelFileName, number>>;
}

function remoteUrl(name: ModelFileName): string {
  return `${MODEL_ROOT}/${name}`;
}

function partialChunkUrl(name: ModelFileName, index: number): string {
  return `${remoteUrl(name)}?sotto-part=${index}`;
}

class RetryableDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableDownloadError";
  }
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
  readonly #now: () => number;
  readonly #sleep: (milliseconds: number) => Promise<void>;
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
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
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

  async transcribe(
    audio: Float32Array,
    options: SttTranscriptionOptions = {},
  ): Promise<string> {
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

    options.signal?.throwIfAborted();
    // Parakeet v3 detects language from audio. The pinned parakeet.js
    // decoder does not accept a language token or language configuration.
    const result = await this.#model.transcribe(audio, 16_000, {
      returnTimestamps: false,
      returnConfidences: true,
      enableProfiling: false,
    });
    options.signal?.throwIfAborted();
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
    await this.#sweepStagingCaches();
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
    const staging = await this.#cacheStorage.open(STAGING_CACHE_NAME);
    const manifest =
      await this.#readStagingManifest(staging) ??
      await this.#createStagingManifest(staging);
    let completedBytes = 0;

    try {
      for (const file of this.#files) {
        const staged = manifest.files[file.name];
        if (await this.#hasValidStagedFile(staging, file.name, file.size, staged)) {
          completedBytes += file.size;
          this.#emit({
            status: "downloading",
            file: file.name,
            loaded: completedBytes,
            total: this.#totalBytes,
            progress: completedBytes / this.#totalBytes,
            resumable: true,
          });
          continue;
        }
        if (staged.complete) {
          await this.#resetStagedFile(staging, manifest, file.name);
        }
        await this.#downloadWithRetry(
          staging,
          manifest,
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
        resumable: false,
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
      await this.#cacheStorage.delete(STAGING_CACHE_NAME);
      return cache;
    } catch (error) {
      await this.#clearCommittedFiles(cache);
      throw error;
    }
  }

  async #downloadWithRetry(
    cache: Cache,
    manifest: StagingManifest,
    url: string,
    fileName: ModelFileName,
    size: number,
    completedBytes: number,
  ): Promise<void> {
    for (let attempt = 0; attempt < DOWNLOAD_ATTEMPTS; attempt += 1) {
      try {
        await this.#downloadToCache(
          cache,
          manifest,
          url,
          fileName,
          size,
          completedBytes,
        );
        return;
      } catch (error) {
        if (
          !(error instanceof RetryableDownloadError) ||
          attempt === DOWNLOAD_ATTEMPTS - 1
        ) {
          throw error;
        }
        await this.#sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
      }
    }
  }

  async #downloadToCache(
    cache: Cache,
    manifest: StagingManifest,
    url: string,
    fileName: ModelFileName,
    size: number,
    completedBytes: number,
  ): Promise<void> {
    let staged = manifest.files[fileName];
    if (staged.offset > 0 && staged.rangeSupported !== true) {
      await this.#resetStagedFile(cache, manifest, fileName);
      staged = manifest.files[fileName];
    }
    if (staged.offset === size && staged.chunks > 0) {
      await this.#commitStagedFile(cache, manifest, fileName, size);
      return;
    }

    const requestedOffset = staged.offset;
    this.#emit({
      status: "downloading",
      file: fileName,
      loaded: completedBytes + requestedOffset,
      total: this.#totalBytes,
      progress: (completedBytes + requestedOffset) / this.#totalBytes,
      resumable: completedBytes + requestedOffset > 0,
    });

    let response: Response;
    try {
      response = await this.#fetch(url, {
        cache: "no-store",
        ...(requestedOffset > 0
          ? { headers: { Range: `bytes=${requestedOffset}-` } }
          : {}),
      });
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : "network request failed";
      throw new RetryableDownloadError(
        `Parakeet download failed for ${fileName}: ${detail}`,
      );
    }

    if (!response.ok || !response.body) {
      const message =
        `Parakeet download failed for ${fileName} (${response.status})`;
      if (
        response.status === 408 ||
        response.status === 429 ||
        response.status >= 500
      ) {
        throw new RetryableDownloadError(message);
      }
      throw new Error(message);
    }

    if (requestedOffset > 0 && response.status === 200) {
      await this.#resetStagedFile(cache, manifest, fileName);
      staged = manifest.files[fileName];
    } else if (requestedOffset > 0) {
      if (response.status !== 206) {
        throw new Error(
          `Parakeet ${fileName} resume failed (${response.status})`,
        );
      }
      this.#validateContentRange(response, fileName, requestedOffset, size);
    } else if (response.status !== 200) {
      throw new Error(
        `Parakeet ${fileName} download returned ${response.status}`,
      );
    }

    const expectedLength = size - staged.offset;
    const declaredLength = Number(response.headers.get("content-length"));
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > 0 &&
      declaredLength !== expectedLength
    ) {
      throw new Error(
        `Parakeet ${fileName} size mismatch: expected ${expectedLength}, got ${declaredLength}`,
      );
    }

    // Hugging Face resolve endpoints advertise byte ranges. If this
    // response does not, the next attempt restarts the file from zero.
    staged.rangeSupported = staged.offset > 0 ||
      response.headers.get("accept-ranges")?.toLowerCase()
        .split(/\s*,\s*/)
        .includes("bytes") === true;
    const contentType = response.headers.get("content-type");
    if (contentType !== null) staged.contentType = contentType;

    const reader = response.body.getReader();
    let bufferedChunks: Uint8Array[] = [];
    let bufferedBytes = 0;
    const persistBufferedBytes = async (): Promise<void> => {
      if (bufferedBytes === 0) return;
      const bytes = new Uint8Array(bufferedBytes);
      let writeOffset = 0;
      for (const chunk of bufferedChunks) {
        bytes.set(chunk, writeOffset);
        writeOffset += chunk.byteLength;
      }
      await cache.put(
        partialChunkUrl(fileName, staged.chunks),
        new Response(bytes, {
          headers: { "content-length": String(bytes.byteLength) },
        }),
      );
      staged.offset += bytes.byteLength;
      staged.chunks += 1;
      bufferedChunks = [];
      bufferedBytes = 0;
      await this.#writeStagingManifest(cache, manifest);
      this.#emit({
        status: "downloading",
        file: fileName,
        loaded: completedBytes + staged.offset,
        total: this.#totalBytes,
        progress: (completedBytes + staged.offset) / this.#totalBytes,
        resumable: true,
      });
    };
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        const chunk = result.value;
        if (chunk.byteLength === 0) continue;
        if (staged.offset + bufferedBytes + chunk.byteLength > size) {
          bufferedChunks = [];
          bufferedBytes = 0;
          await this.#resetStagedFile(cache, manifest, fileName);
          throw new Error(
            `Parakeet ${fileName} exceeded its pinned size of ${size} bytes`,
          );
        }
        bufferedChunks.push(chunk);
        bufferedBytes += chunk.byteLength;
        if (bufferedBytes >= PARTIAL_CHUNK_BYTES) {
          await persistBufferedBytes();
        }
      }
      await persistBufferedBytes();
    } catch (error) {
      await persistBufferedBytes();
      if (error instanceof RetryableDownloadError) throw error;
      const detail =
        error instanceof Error ? error.message : "network stream failed";
      throw new RetryableDownloadError(
        `Parakeet download failed for ${fileName}: ${detail}`,
      );
    } finally {
      reader.releaseLock();
    }

    if (staged.offset !== size) {
      throw new RetryableDownloadError(
        `Parakeet ${fileName} download stopped at ${staged.offset} of ${size} bytes`,
      );
    }
    await this.#commitStagedFile(cache, manifest, fileName, size);
  }

  #validateContentRange(
    response: Response,
    fileName: ModelFileName,
    offset: number,
    size: number,
  ): void {
    const value = response.headers.get("content-range");
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value ?? "");
    const start = Number(match?.[1]);
    const end = Number(match?.[2]);
    const total = Number(match?.[3]);
    if (
      !match ||
      start !== offset ||
      end !== size - 1 ||
      total !== size
    ) {
      throw new Error(
        `Parakeet ${fileName} returned an invalid Content-Range`,
      );
    }
  }

  async #commitStagedFile(
    cache: Cache,
    manifest: StagingManifest,
    fileName: ModelFileName,
    size: number,
  ): Promise<void> {
    const staged = manifest.files[fileName];
    const chunkCount = staged.chunks;
    let index = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (index >= chunkCount) {
          controller.close();
          return;
        }
        const response = await cache.match(partialChunkUrl(fileName, index));
        if (!response) {
          controller.error(
            new Error(`Parakeet staging cache lost ${fileName} part ${index}`),
          );
          return;
        }
        index += 1;
        controller.enqueue(new Uint8Array(await response.arrayBuffer()));
      },
    });
    await cache.put(
      remoteUrl(fileName),
      new Response(body, {
        status: 200,
        headers: {
          [CACHE_SIZE_HEADER]: String(size),
          "content-length": String(size),
          ...(staged.contentType === undefined
            ? {}
            : { "content-type": staged.contentType }),
        },
      }),
    );
    staged.complete = true;
    staged.offset = size;
    staged.chunks = 0;
    await this.#writeStagingManifest(cache, manifest);
    await Promise.all(
      Array.from(
        { length: chunkCount },
        (_, chunkIndex) =>
          cache.delete(partialChunkUrl(fileName, chunkIndex)),
      ),
    );
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

  async #sweepStagingCaches(): Promise<void> {
    if (typeof this.#cacheStorage.keys !== "function") return;
    const names = await this.#cacheStorage.keys();
    for (const name of names) {
      if (!name.startsWith(`${CACHE_NAME}-staging`)) continue;
      if (name !== STAGING_CACHE_NAME) {
        await this.#cacheStorage.delete(name);
        continue;
      }
      const cache = await this.#cacheStorage.open(name);
      const manifest = await this.#readStagingManifest(cache);
      if (
        !manifest ||
        this.#now() - manifest.updatedAt > PARTIAL_MAX_AGE_MS
      ) {
        await this.#cacheStorage.delete(name);
      }
    }
  }

  async #createStagingManifest(cache: Cache): Promise<StagingManifest> {
    const manifest: StagingManifest = {
      revision: PARAKEET_MODEL_REVISION,
      total: this.#totalBytes,
      updatedAt: this.#now(),
      files: Object.fromEntries(
        this.#files.map((file) => [
          file.name,
          {
            size: file.size,
            offset: 0,
            chunks: 0,
            complete: false,
          },
        ]),
      ) as Record<ModelFileName, StagedFile>,
    };
    await this.#writeStagingManifest(cache, manifest);
    return manifest;
  }

  async #readStagingManifest(
    cache: Cache,
  ): Promise<StagingManifest | undefined> {
    const response = await cache.match(STAGING_MANIFEST_URL);
    if (!response) return undefined;
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      return undefined;
    }
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value)
    ) {
      return undefined;
    }
    const manifest = value as Record<string, unknown>;
    if (
      manifest.revision !== PARAKEET_MODEL_REVISION ||
      manifest.total !== this.#totalBytes ||
      typeof manifest.updatedAt !== "number" ||
      !Number.isFinite(manifest.updatedAt) ||
      typeof manifest.files !== "object" ||
      manifest.files === null ||
      Array.isArray(manifest.files)
    ) {
      return undefined;
    }
    const files = manifest.files as Record<string, unknown>;
    for (const file of this.#files) {
      const entry = files[file.name];
      if (
        typeof entry !== "object" ||
        entry === null ||
        Array.isArray(entry)
      ) {
        return undefined;
      }
      const staged = entry as Record<string, unknown>;
      if (
        staged.size !== file.size ||
        typeof staged.offset !== "number" ||
        !Number.isInteger(staged.offset) ||
        staged.offset < 0 ||
        staged.offset > file.size ||
        typeof staged.chunks !== "number" ||
        !Number.isInteger(staged.chunks) ||
        staged.chunks < 0 ||
        typeof staged.complete !== "boolean" ||
        (staged.complete && staged.offset !== file.size) ||
        (staged.rangeSupported !== undefined &&
          typeof staged.rangeSupported !== "boolean") ||
        (staged.contentType !== undefined &&
          typeof staged.contentType !== "string")
      ) {
        return undefined;
      }
    }
    return value as StagingManifest;
  }

  async #writeStagingManifest(
    cache: Cache,
    manifest: StagingManifest,
  ): Promise<void> {
    manifest.updatedAt = this.#now();
    await cache.put(
      STAGING_MANIFEST_URL,
      new Response(JSON.stringify(manifest), {
        headers: { "content-type": "application/json" },
      }),
    );
  }

  async #hasValidStagedFile(
    cache: Cache,
    fileName: ModelFileName,
    size: number,
    staged: StagedFile,
  ): Promise<boolean> {
    if (!staged.complete || staged.offset !== size) return false;
    const response = await cache.match(remoteUrl(fileName));
    return response !== undefined &&
      Number(response.headers.get(CACHE_SIZE_HEADER)) === size;
  }

  async #resetStagedFile(
    cache: Cache,
    manifest: StagingManifest,
    fileName: ModelFileName,
  ): Promise<void> {
    const staged = manifest.files[fileName];
    await Promise.all([
      cache.delete(remoteUrl(fileName)),
      ...Array.from(
        { length: staged.chunks },
        (_, index) => cache.delete(partialChunkUrl(fileName, index)),
      ),
    ]);
    manifest.files[fileName] = {
      size: staged.size,
      offset: 0,
      chunks: 0,
      complete: false,
    };
    await this.#writeStagingManifest(cache, manifest);
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
