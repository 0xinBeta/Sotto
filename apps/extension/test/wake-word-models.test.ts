import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
} from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  WAKE_WORD_MODEL_ASSETS,
  WAKE_WORD_MODEL_ID,
  WAKE_WORD_MODEL_REVISION,
  WakeWordModelStore,
  type WakeWordModelAsset,
  type WakeWordModelRole,
} from "../src/wake-word-models.js";
import {
  WakeWordController,
  type WakeAudioCapture,
  type WakeFrameModel,
} from "../src/wake-word.js";

function requestUrl(request: RequestInfo | URL): string {
  return request instanceof Request ? request.url : String(request);
}

class MemoryCache {
  readonly responses = new Map<string, Response>();

  async match(request: RequestInfo | URL): Promise<Response | undefined> {
    return this.responses.get(requestUrl(request))?.clone();
  }

  async put(
    request: RequestInfo | URL,
    response: Response,
  ): Promise<void> {
    this.responses.set(requestUrl(request), response.clone());
  }

  async delete(request: RequestInfo | URL): Promise<boolean> {
    return this.responses.delete(requestUrl(request));
  }

  async keys(): Promise<readonly Request[]> {
    return [...this.responses.keys()].map((url) => new Request(url));
  }
}

class MemoryCacheStorage {
  readonly caches = new Map<string, MemoryCache>();

  async open(name: string): Promise<Cache> {
    let cache = this.caches.get(name);
    if (!cache) {
      cache = new MemoryCache();
      this.caches.set(name, cache);
    }
    return cache as unknown as Cache;
  }

  async delete(name: string): Promise<boolean> {
    return this.caches.delete(name);
  }

  async keys(): Promise<string[]> {
    return [...this.caches.keys()];
  }
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function testAssets(
  bytes: Readonly<Record<WakeWordModelRole, Uint8Array>>,
): Readonly<Record<WakeWordModelRole, WakeWordModelAsset>> {
  return {
    melspectrogram: {
      file: "melspectrogram.onnx",
      bytes: bytes.melspectrogram.byteLength,
      sha256: hash(bytes.melspectrogram),
    },
    embedding: {
      file: "embedding_model.onnx",
      bytes: bytes.embedding.byteLength,
      sha256: hash(bytes.embedding),
    },
    classifier: {
      file: "hey_jarvis_v0.1.onnx",
      bytes: bytes.classifier.byteLength,
      sha256: hash(bytes.classifier),
    },
  };
}

class FakeModel implements WakeFrameModel {
  processFrame = vi.fn(async () => 0);
  reset = vi.fn();
  dispose = vi.fn(async () => undefined);
}

class FakeCapture implements WakeAudioCapture {
  start = vi.fn(async () => undefined);
  stop = vi.fn(async () => undefined);
}

describe("wake model downloads", () => {
  it("pins the exact Hugging Face revision, sizes, and hashes", () => {
    expect(WAKE_WORD_MODEL_ID).toBe("harvestsu/openwakeword-onnx");
    expect(WAKE_WORD_MODEL_REVISION).toBe(
      "93d1bd6f4f48750cb6a76206ce5bd92d846820c8",
    );
    expect(WAKE_WORD_MODEL_ASSETS).toEqual({
      melspectrogram: {
        file: "melspectrogram.onnx",
        bytes: 1_087_958,
        sha256:
          "ba2b0e0f8b7b875369a2c89cb13360ff53bac436f2895cced9f479fa65eb176f",
      },
      embedding: {
        file: "embedding_model.onnx",
        bytes: 1_326_578,
        sha256:
          "70d164290c1d095d1d4ee149bc5e00543250a7316b59f31d056cff7bd3075c1f",
      },
      classifier: {
        file: "hey_jarvis_v0.1.onnx",
        bytes: 1_271_370,
        sha256:
          "94a13cfe60075b132f6a472e7e462e8123ee70861bc3fb58434a73712ee0d2cb",
      },
    });
  });

  it("downloads and verifies every file before it arms capture", async () => {
    const bytes = {
      melspectrogram: new Uint8Array([1, 2, 3]),
      embedding: new Uint8Array([4, 5]),
      classifier: new Uint8Array([6, 7, 8, 9]),
    };
    const assets = testAssets(bytes);
    let releaseFirstFetch: ((response: Response) => void) | undefined;
    const firstFetch = new Promise<Response>((resolve) => {
      releaseFirstFetch = resolve;
    });
    const fetch = vi.fn()
      .mockReturnValueOnce(firstFetch)
      .mockResolvedValueOnce(new Response(bytes.embedding))
      .mockResolvedValueOnce(new Response(bytes.classifier));
    const progress: string[] = [];
    const store = new WakeWordModelStore({
      cacheStorage: new MemoryCacheStorage() as unknown as CacheStorage,
      fetch,
      assets,
      modelRoot: "https://huggingface.co/test/wake/resolve/revision",
      cacheName: "test-wake-models",
      sleep: async () => undefined,
    });
    const capture = new FakeCapture();
    const controller = new WakeWordController({
      createModel: async () => {
        await store.load((event) => progress.push(event.status));
        return new FakeModel();
      },
      createCapture: () => capture,
      onDetected: vi.fn(),
      yieldControl: async () => undefined,
    });

    const enabling = controller.setEnabled(true);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(capture.start).not.toHaveBeenCalled();

    releaseFirstFetch?.(new Response(bytes.melspectrogram));
    await enabling;

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(progress).toContain("downloading");
    expect(progress.at(-1)).toBe("ready");
    expect(capture.start).toHaveBeenCalledOnce();
    expect(controller.state).toBe("armed");
  });

  it("refuses activation when a downloaded hash is wrong", async () => {
    const bytes = {
      melspectrogram: new Uint8Array([1]),
      embedding: new Uint8Array([2]),
      classifier: new Uint8Array([3]),
    };
    const assets = testAssets(bytes);
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(bytes.melspectrogram))
      .mockResolvedValueOnce(new Response(bytes.embedding))
      .mockResolvedValueOnce(new Response(new Uint8Array([4])));
    const store = new WakeWordModelStore({
      cacheStorage: new MemoryCacheStorage() as unknown as CacheStorage,
      fetch,
      assets,
      modelRoot: "https://huggingface.co/test/wake/resolve/revision",
      cacheName: "test-wake-bad-hash",
      sleep: async () => undefined,
    });
    const capture = new FakeCapture();
    const controller = new WakeWordController({
      createModel: async () => {
        await store.load();
        return new FakeModel();
      },
      createCapture: () => capture,
      onDetected: vi.fn(),
      yieldControl: async () => undefined,
    });

    await expect(controller.setEnabled(true)).rejects.toThrow(
      "failed SHA-256 verification",
    );
    expect(capture.start).not.toHaveBeenCalled();
    expect(controller.state).toBe("error");
  });

  it("resumes an interrupted file with a byte range", async () => {
    const bytes = {
      melspectrogram: new Uint8Array([1, 2, 3, 4]),
      embedding: new Uint8Array([5]),
      classifier: new Uint8Array([6]),
    };
    const assets = testAssets(bytes);
    let reads = 0;
    const interrupted = {
      ok: true,
      status: 200,
      headers: new Headers({
        "accept-ranges": "bytes",
        "content-length": "4",
      }),
      body: {
        getReader() {
          return {
            async read() {
              reads += 1;
              if (reads === 1) {
                return {
                  done: false,
                  value: bytes.melspectrogram.subarray(0, 2),
                };
              }
              throw new Error("connection stopped");
            },
            releaseLock() {},
          };
        },
      },
    } as unknown as Response;
    const fetch = vi.fn()
      .mockResolvedValueOnce(interrupted)
      .mockResolvedValueOnce(
        new Response(bytes.melspectrogram.subarray(2), {
          status: 206,
          headers: {
            "content-length": "2",
            "content-range": "bytes 2-3/4",
          },
        }),
      )
      .mockResolvedValueOnce(new Response(bytes.embedding))
      .mockResolvedValueOnce(new Response(bytes.classifier));
    const store = new WakeWordModelStore({
      cacheStorage: new MemoryCacheStorage() as unknown as CacheStorage,
      fetch,
      assets,
      modelRoot: "https://huggingface.co/test/wake/resolve/revision",
      cacheName: "test-wake-resume",
      sleep: async () => undefined,
    });

    await expect(store.load()).resolves.toMatchObject({
      melspectrogram: bytes.melspectrogram,
    });
    expect(
      new Headers(fetch.mock.calls[1]?.[1]?.headers).get("range"),
    ).toBe("bytes=2-");
  });

  it("keeps wake ONNX files out of public assets and build output", () => {
    const forbidden = new Set(
      Object.values(WAKE_WORD_MODEL_ASSETS).map((asset) => asset.file),
    );
    for (const directory of [
      new URL("../public/assets/wake-word/", import.meta.url),
      new URL("../dist/", import.meta.url),
    ]) {
      if (!existsSync(directory)) continue;
      const files = readdirSync(directory, {
        recursive: true,
        withFileTypes: true,
      });
      const bundled = files
        .filter((entry) => entry.isFile() && forbidden.has(entry.name))
        .map((entry) => entry.name);
      expect(bundled).toEqual([]);
    }
  });
});
