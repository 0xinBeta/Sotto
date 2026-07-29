export const WAKE_WORD_MODEL_ID = "harvestsu/openwakeword-onnx";
export const WAKE_WORD_MODEL_REVISION =
  "93d1bd6f4f48750cb6a76206ce5bd92d846820c8";

const MODEL_ROOT =
  `https://huggingface.co/${WAKE_WORD_MODEL_ID}/resolve/` +
  WAKE_WORD_MODEL_REVISION;
const CACHE_NAME = `sotto-wake-word-${WAKE_WORD_MODEL_REVISION}`;
const STAGING_CACHE_NAME = `${CACHE_NAME}-staging`;
const STAGING_MANIFEST_URL = `${MODEL_ROOT}/.sotto-staging-manifest.json`;
const CACHE_SIZE_HEADER = "x-sotto-validated-size";
export const WAKE_WORD_CACHE_HASH_HEADER =
  "x-sotto-validated-sha256";
const PARTIAL_CHUNK_BYTES = 256 * 1_024;
const DOWNLOAD_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 250;

export type WakeWordModelRole =
  | "melspectrogram"
  | "embedding"
  | "classifier";

export interface WakeWordModelAsset {
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
}

export const WAKE_WORD_MODEL_ASSETS: Readonly<
  Record<WakeWordModelRole, WakeWordModelAsset>
> = Object.freeze({
  melspectrogram: {
    file: "melspectrogram.onnx",
    bytes: 1_087_958,
    sha256: "ba2b0e0f8b7b875369a2c89cb13360ff53bac436f2895cced9f479fa65eb176f",
  },
  embedding: {
    file: "embedding_model.onnx",
    bytes: 1_326_578,
    sha256: "70d164290c1d095d1d4ee149bc5e00543250a7316b59f31d056cff7bd3075c1f",
  },
  classifier: {
    file: "hey_jarvis_v0.1.onnx",
    bytes: 1_271_370,
    sha256: "94a13cfe60075b132f6a472e7e462e8123ee70861bc3fb58434a73712ee0d2cb",
  },
});

export type WakeWordModelBytes = Readonly<
  Record<WakeWordModelRole, Uint8Array>
>;

export interface WakeWordModelProgress {
  readonly status: "downloading" | "validating" | "ready" | "error";
  readonly progress: number;
  readonly loaded: number;
  readonly total: number;
  readonly file?: string;
  readonly resumable?: boolean;
}

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
  files: Record<WakeWordModelRole, StagedFile>;
}

interface WakeWordModelStoreOptions {
  readonly cacheStorage?: CacheStorage;
  readonly fetch?: typeof globalThis.fetch;
  readonly assets?: Readonly<
    Record<WakeWordModelRole, WakeWordModelAsset>
  >;
  readonly modelRoot?: string;
  readonly cacheName?: string;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

class RetryableDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableDownloadError";
  }
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, "0")
  ).join("");
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

export class WakeWordModelStore {
  readonly #cacheStorage: CacheStorage | undefined;
  readonly #fetch: typeof globalThis.fetch;
  readonly #assets: Readonly<
    Record<WakeWordModelRole, WakeWordModelAsset>
  >;
  readonly #modelRoot: string;
  readonly #cacheName: string;
  readonly #stagingCacheName: string;
  readonly #manifestUrl: string;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #totalBytes: number;
  #loadPromise: Promise<WakeWordModelBytes> | undefined;

  get loading(): boolean {
    return this.#loadPromise !== undefined;
  }

  constructor(options: WakeWordModelStoreOptions = {}) {
    this.#cacheStorage = options.cacheStorage ?? globalThis.caches;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#assets = options.assets ?? WAKE_WORD_MODEL_ASSETS;
    this.#modelRoot = options.modelRoot ?? MODEL_ROOT;
    this.#cacheName = options.cacheName ?? CACHE_NAME;
    this.#stagingCacheName = `${this.#cacheName}-staging`;
    this.#manifestUrl = options.modelRoot
      ? `${options.modelRoot}/.sotto-staging-manifest.json`
      : STAGING_MANIFEST_URL;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#totalBytes = Object.values(this.#assets).reduce(
      (total, asset) => total + asset.bytes,
      0,
    );
  }

  load(
    onProgress?: (progress: WakeWordModelProgress) => void,
  ): Promise<WakeWordModelBytes> {
    this.#loadPromise ??= this.#load(onProgress)
      .catch((error: unknown) => {
        this.#emit(onProgress, {
          status: "error",
          progress: 0,
          loaded: 0,
          total: this.#totalBytes,
        });
        throw error;
      })
      .finally(() => {
        this.#loadPromise = undefined;
      });
    return this.#loadPromise;
  }

  async clear(): Promise<void> {
    if (this.#loadPromise) {
      throw new Error("Wait for the model task to finish");
    }
    if (!this.#cacheStorage) return;
    await Promise.all([
      this.#cacheStorage.delete(this.#cacheName),
      this.#cacheStorage.delete(this.#stagingCacheName),
    ]);
  }

  async #load(
    onProgress?: (progress: WakeWordModelProgress) => void,
  ): Promise<WakeWordModelBytes> {
    const cacheStorage = this.#cacheStorage;
    if (!cacheStorage) {
      throw new Error("Wake model storage is unavailable");
    }
    const committed = await cacheStorage.open(this.#cacheName);
    const cached = await this.#readValidatedFiles(committed, onProgress);
    if (cached) {
      this.#emit(onProgress, {
        status: "ready",
        progress: 1,
        loaded: this.#totalBytes,
        total: this.#totalBytes,
      });
      return cached;
    }

    await this.#clearFiles(committed);
    const staging = await cacheStorage.open(this.#stagingCacheName);
    const manifest =
      await this.#readManifest(staging) ??
      await this.#createManifest(staging);
    let completedBytes = 0;

    try {
      for (const role of this.#roles()) {
        const asset = this.#assets[role];
        const staged = manifest.files[role];
        let valid = false;
        if (staged.complete) {
          const response = await staging.match(this.#remoteUrl(asset.file));
          valid = response
            ? await this.#validateResponse(response, asset)
            : false;
          if (!valid) {
            await this.#resetStagedFile(staging, manifest, role);
          }
        }
        if (!valid) {
          await this.#downloadWithRetry(
            staging,
            manifest,
            role,
            completedBytes,
            onProgress,
          );
          const response = await staging.match(this.#remoteUrl(asset.file));
          if (!response || !(await this.#validateResponse(response, asset))) {
            await this.#resetStagedFile(staging, manifest, role);
            throw new Error(
              `Wake model ${asset.file} failed SHA-256 verification`,
            );
          }
        }
        completedBytes += asset.bytes;
        this.#emit(onProgress, {
          status: "validating",
          file: asset.file,
          progress: completedBytes / this.#totalBytes,
          loaded: completedBytes,
          total: this.#totalBytes,
        });
      }

      await this.#clearFiles(committed);
      for (const role of this.#roles()) {
        const asset = this.#assets[role];
        const url = this.#remoteUrl(asset.file);
        const response = await staging.match(url);
        if (!response) {
          throw new Error(`Wake model staging lost ${asset.file}`);
        }
        const bytes = await response.arrayBuffer();
        await committed.put(
          url,
          new Response(bytes, {
            headers: {
              [CACHE_SIZE_HEADER]: String(asset.bytes),
              [WAKE_WORD_CACHE_HASH_HEADER]: asset.sha256,
              "content-type": "application/octet-stream",
            },
          }),
        );
      }
      await cacheStorage.delete(this.#stagingCacheName);
      const validated = await this.#readValidatedFiles(
        committed,
        onProgress,
      );
      if (!validated) {
        throw new Error("Wake model cache validation failed");
      }
      this.#emit(onProgress, {
        status: "ready",
        progress: 1,
        loaded: this.#totalBytes,
        total: this.#totalBytes,
      });
      return validated;
    } catch (error) {
      await this.#clearFiles(committed);
      throw error;
    }
  }

  async #readValidatedFiles(
    cache: Cache,
    onProgress?: (progress: WakeWordModelProgress) => void,
  ): Promise<WakeWordModelBytes | undefined> {
    const files = {} as Record<WakeWordModelRole, Uint8Array>;
    let validatedBytes = 0;
    for (const role of this.#roles()) {
      const asset = this.#assets[role];
      const response = await cache.match(this.#remoteUrl(asset.file));
      if (
        !response ||
        response.headers.get(WAKE_WORD_CACHE_HASH_HEADER) !== asset.sha256 ||
        !(await this.#validateResponse(response, asset))
      ) {
        return undefined;
      }
      files[role] = new Uint8Array(await response.arrayBuffer());
      validatedBytes += asset.bytes;
      this.#emit(onProgress, {
        status: "validating",
        file: asset.file,
        progress: validatedBytes / this.#totalBytes,
        loaded: validatedBytes,
        total: this.#totalBytes,
      });
    }
    return files;
  }

  async #downloadWithRetry(
    cache: Cache,
    manifest: StagingManifest,
    role: WakeWordModelRole,
    completedBytes: number,
    onProgress?: (progress: WakeWordModelProgress) => void,
  ): Promise<void> {
    for (let attempt = 0; attempt < DOWNLOAD_ATTEMPTS; attempt += 1) {
      try {
        await this.#download(
          cache,
          manifest,
          role,
          completedBytes,
          onProgress,
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

  async #download(
    cache: Cache,
    manifest: StagingManifest,
    role: WakeWordModelRole,
    completedBytes: number,
    onProgress?: (progress: WakeWordModelProgress) => void,
  ): Promise<void> {
    const asset = this.#assets[role];
    let staged = manifest.files[role];
    if (staged.offset > 0 && staged.rangeSupported !== true) {
      await this.#resetStagedFile(cache, manifest, role);
      staged = manifest.files[role];
    }
    if (staged.offset === asset.bytes && staged.chunks > 0) {
      await this.#commitStagedFile(cache, manifest, role);
      return;
    }

    const requestedOffset = staged.offset;
    this.#emit(onProgress, {
      status: "downloading",
      file: asset.file,
      progress: (completedBytes + requestedOffset) / this.#totalBytes,
      loaded: completedBytes + requestedOffset,
      total: this.#totalBytes,
      resumable: completedBytes + requestedOffset > 0,
    });

    let response: Response;
    try {
      response = await this.#fetch(this.#remoteUrl(asset.file), {
        cache: "no-store",
        ...(requestedOffset > 0
          ? { headers: { Range: `bytes=${requestedOffset}-` } }
          : {}),
      });
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : "network request failed";
      throw new RetryableDownloadError(
        `Wake model download failed for ${asset.file}: ${detail}`,
      );
    }
    if (!response.ok || !response.body) {
      const message =
        `Wake model download failed for ${asset.file} (${response.status})`;
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
      await this.#resetStagedFile(cache, manifest, role);
      staged = manifest.files[role];
    } else if (requestedOffset > 0) {
      if (response.status !== 206) {
        throw new Error(
          `Wake model ${asset.file} resume failed (${response.status})`,
        );
      }
      this.#validateContentRange(response, asset, requestedOffset);
    } else if (response.status !== 200) {
      throw new Error(
        `Wake model ${asset.file} download returned ${response.status}`,
      );
    }

    const expectedLength = asset.bytes - staged.offset;
    const declaredLength = Number(response.headers.get("content-length"));
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > 0 &&
      declaredLength !== expectedLength
    ) {
      throw new Error(
        `Wake model ${asset.file} size mismatch: expected ` +
          `${expectedLength}, got ${declaredLength}`,
      );
    }
    staged.rangeSupported = staged.offset > 0 ||
      response.headers.get("accept-ranges")?.toLowerCase()
        .split(/\s*,\s*/)
        .includes("bytes") === true;
    const contentType = response.headers.get("content-type");
    if (contentType !== null) staged.contentType = contentType;

    const reader = response.body.getReader();
    let buffered: Uint8Array[] = [];
    let bufferedBytes = 0;
    const persist = async (): Promise<void> => {
      if (bufferedBytes === 0) return;
      const bytes = new Uint8Array(bufferedBytes);
      let offset = 0;
      for (const chunk of buffered) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      await cache.put(
        this.#partialUrl(asset.file, staged.chunks),
        new Response(bytes, {
          headers: { "content-length": String(bytes.byteLength) },
        }),
      );
      staged.offset += bytes.byteLength;
      staged.chunks += 1;
      buffered = [];
      bufferedBytes = 0;
      await this.#writeManifest(cache, manifest);
      this.#emit(onProgress, {
        status: "downloading",
        file: asset.file,
        progress: (completedBytes + staged.offset) / this.#totalBytes,
        loaded: completedBytes + staged.offset,
        total: this.#totalBytes,
        resumable: true,
      });
    };

    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        const chunk = result.value;
        if (chunk.byteLength === 0) continue;
        if (staged.offset + bufferedBytes + chunk.byteLength > asset.bytes) {
          buffered = [];
          bufferedBytes = 0;
          await this.#resetStagedFile(cache, manifest, role);
          throw new Error(
            `Wake model ${asset.file} exceeded ${asset.bytes} bytes`,
          );
        }
        buffered.push(chunk);
        bufferedBytes += chunk.byteLength;
        if (bufferedBytes >= PARTIAL_CHUNK_BYTES) await persist();
      }
      await persist();
    } catch (error) {
      await persist();
      const detail =
        error instanceof Error ? error.message : "network stream failed";
      throw new RetryableDownloadError(
        `Wake model download failed for ${asset.file}: ${detail}`,
      );
    } finally {
      reader.releaseLock();
    }

    if (staged.offset !== asset.bytes) {
      throw new RetryableDownloadError(
        `Wake model ${asset.file} stopped at ${staged.offset} ` +
          `of ${asset.bytes} bytes`,
      );
    }
    await this.#commitStagedFile(cache, manifest, role);
  }

  #validateContentRange(
    response: Response,
    asset: WakeWordModelAsset,
    offset: number,
  ): void {
    const value = response.headers.get("content-range");
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value ?? "");
    if (
      !match ||
      Number(match[1]) !== offset ||
      Number(match[2]) !== asset.bytes - 1 ||
      Number(match[3]) !== asset.bytes
    ) {
      throw new Error(
        `Wake model ${asset.file} returned an invalid Content-Range`,
      );
    }
  }

  async #commitStagedFile(
    cache: Cache,
    manifest: StagingManifest,
    role: WakeWordModelRole,
  ): Promise<void> {
    const asset = this.#assets[role];
    const staged = manifest.files[role];
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (let index = 0; index < staged.chunks; index += 1) {
      const response = await cache.match(this.#partialUrl(asset.file, index));
      if (!response) {
        throw new RetryableDownloadError(
          `Wake model staging lost ${asset.file} part ${index}`,
        );
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      chunks.push(bytes);
      total += bytes.byteLength;
    }
    if (total !== asset.bytes) {
      throw new RetryableDownloadError(
        `Wake model staging has ${total} of ${asset.bytes} bytes`,
      );
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    await cache.put(
      this.#remoteUrl(asset.file),
      new Response(bytes, {
        headers: {
          "content-length": String(asset.bytes),
          ...(staged.contentType === undefined
            ? {}
            : { "content-type": staged.contentType }),
        },
      }),
    );
    const chunkCount = staged.chunks;
    staged.complete = true;
    staged.offset = asset.bytes;
    staged.chunks = 0;
    await this.#writeManifest(cache, manifest);
    await Promise.all(
      Array.from(
        { length: chunkCount },
        (_, index) => cache.delete(this.#partialUrl(asset.file, index)),
      ),
    );
  }

  async #validateResponse(
    response: Response,
    asset: WakeWordModelAsset,
  ): Promise<boolean> {
    const bytes = new Uint8Array(await response.clone().arrayBuffer());
    return bytes.byteLength === asset.bytes &&
      await sha256(bytes) === asset.sha256;
  }

  async #createManifest(cache: Cache): Promise<StagingManifest> {
    const manifest: StagingManifest = {
      revision: WAKE_WORD_MODEL_REVISION,
      total: this.#totalBytes,
      files: Object.fromEntries(
        this.#roles().map((role) => [
          role,
          {
            size: this.#assets[role].bytes,
            offset: 0,
            chunks: 0,
            complete: false,
          },
        ]),
      ) as Record<WakeWordModelRole, StagedFile>,
    };
    await this.#writeManifest(cache, manifest);
    return manifest;
  }

  async #readManifest(cache: Cache): Promise<StagingManifest | undefined> {
    const response = await cache.match(this.#manifestUrl);
    if (!response) return undefined;
    try {
      const value = await response.json() as Partial<StagingManifest>;
      if (
        value.revision !== WAKE_WORD_MODEL_REVISION ||
        value.total !== this.#totalBytes ||
        !value.files
      ) {
        return undefined;
      }
      for (const role of this.#roles()) {
        const file = value.files[role];
        const expectedSize = this.#assets[role].bytes;
        if (
          !file ||
          file.size !== expectedSize ||
          !Number.isInteger(file.offset) ||
          file.offset < 0 ||
          file.offset > expectedSize ||
          !Number.isInteger(file.chunks) ||
          file.chunks < 0 ||
          typeof file.complete !== "boolean" ||
          (file.complete && file.offset !== expectedSize) ||
          (file.rangeSupported !== undefined &&
            typeof file.rangeSupported !== "boolean") ||
          (file.contentType !== undefined &&
            typeof file.contentType !== "string")
        ) {
          return undefined;
        }
      }
      return value as StagingManifest;
    } catch {
      return undefined;
    }
  }

  async #writeManifest(
    cache: Cache,
    manifest: StagingManifest,
  ): Promise<void> {
    await cache.put(
      this.#manifestUrl,
      new Response(JSON.stringify(manifest), {
        headers: { "content-type": "application/json" },
      }),
    );
  }

  async #resetStagedFile(
    cache: Cache,
    manifest: StagingManifest,
    role: WakeWordModelRole,
  ): Promise<void> {
    const asset = this.#assets[role];
    const staged = manifest.files[role];
    await Promise.all([
      cache.delete(this.#remoteUrl(asset.file)),
      ...Array.from(
        { length: staged.chunks },
        (_, index) => cache.delete(this.#partialUrl(asset.file, index)),
      ),
    ]);
    manifest.files[role] = {
      size: asset.bytes,
      offset: 0,
      chunks: 0,
      complete: false,
    };
    await this.#writeManifest(cache, manifest);
  }

  async #clearFiles(cache: Cache): Promise<void> {
    await Promise.all(
      this.#roles().map((role) =>
        cache.delete(this.#remoteUrl(this.#assets[role].file))
      ),
    );
  }

  #remoteUrl(file: string): string {
    return `${this.#modelRoot}/${file}`;
  }

  #partialUrl(file: string, index: number): string {
    return `${this.#remoteUrl(file)}?sotto-wake-part=${index}`;
  }

  #roles(): readonly WakeWordModelRole[] {
    return ["melspectrogram", "embedding", "classifier"];
  }

  #emit(
    callback: ((progress: WakeWordModelProgress) => void) | undefined,
    progress: WakeWordModelProgress,
  ): void {
    try {
      callback?.(progress);
    } catch (error) {
      console.warn("Wake model progress callback failed", error);
    }
  }
}
