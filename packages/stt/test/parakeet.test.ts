import { describe, expect, it, vi } from "vitest";

import {
  PARAKEET_MODEL_REVISION,
  ParakeetSttEngine,
} from "../src/index.js";

class FakeCache {
  readonly entries = new Map<string, Response>();

  async match(request: RequestInfo | URL): Promise<Response | undefined> {
    return this.entries.get(String(request))?.clone();
  }

  async put(request: RequestInfo | URL, response: Response): Promise<void> {
    const bytes = await response.arrayBuffer();
    this.entries.set(
      String(request),
      new Response(bytes, {
        status: response.status,
        headers: response.headers,
      }),
    );
  }

  async delete(request: RequestInfo | URL): Promise<boolean> {
    return this.entries.delete(String(request));
  }
}

class FakeCacheStorage {
  readonly caches = new Map<string, FakeCache>();

  async open(name: string): Promise<Cache> {
    let cache = this.caches.get(name);
    if (!cache) {
      cache = new FakeCache();
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

const TEST_SIZES = {
  "encoder-model.int4.onnx": 4,
  "decoder_joint-model.int8.onnx": 3,
  "vocab.txt": 2,
} as const;

function interruptedBody(bytes: number): ReadableStream<Uint8Array> {
  let sent = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true;
        if (bytes > 0) {
          controller.enqueue(new Uint8Array(bytes));
          return;
        }
      }
      controller.error(new Error("connection interrupted"));
    },
  });
}

function harness(options: {
  readonly sizes?: typeof TEST_SIZES;
  readonly failFile?: string;
  readonly cacheStorage?: FakeCacheStorage;
  readonly fetch?: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>;
  readonly now?: () => number;
} = {}) {
  const cacheStorage = options.cacheStorage ?? new FakeCacheStorage();
  const model = {
    transcribe: vi.fn().mockResolvedValue({
      utterance_text: "  open calendar  ",
      tokens: [{ token: "open" }, { token: "calendar" }],
    }),
    dispose: vi.fn().mockResolvedValue(undefined),
  };
  const factory = vi.fn().mockResolvedValue(model);
  const defaultFetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const name = String(input).split("/").at(-1) as keyof typeof TEST_SIZES;
    const expected = (options.sizes ?? TEST_SIZES)[name];
    const range = new Headers(init?.headers).get("range");
    const offset = Number(/^bytes=(\d+)-$/.exec(range ?? "")?.[1] ?? 0);
    const remaining = expected - offset;
    const declared = name === options.failFile
      ? remaining + 1
      : remaining;
    const body = new Uint8Array(remaining);
    return new Response(body, {
      status: offset > 0 ? 206 : 200,
      headers: {
        "content-length": String(declared),
        "content-type": name === "vocab.txt"
          ? "text/plain"
          : "application/octet-stream",
        "accept-ranges": "bytes",
        ...(offset > 0
          ? { "content-range": `bytes ${offset}-${expected - 1}/${expected}` }
          : {}),
      },
    });
  };
  const fetch = vi.fn(options.fetch ?? defaultFetch);
  const sleep = vi.fn().mockResolvedValue(undefined);
  const objectUrls: string[] = [];
  const engine = new ParakeetSttEngine({
    cacheStorage: cacheStorage as unknown as CacheStorage,
    fetch: fetch as typeof globalThis.fetch,
    factory,
    runtimeUrl: (path) => `chrome-extension://sotto/${path}`,
    createObjectUrl: (blob) => {
      const url = `blob:test-${blob.size}-${objectUrls.length}`;
      objectUrls.push(url);
      return url;
    },
    revokeObjectUrl: vi.fn(),
    modelSizes: options.sizes ?? TEST_SIZES,
    ...(options.now === undefined ? {} : { now: options.now }),
    sleep,
  });
  return {
    cacheStorage,
    engine,
    factory,
    fetch,
    model,
    objectUrls,
    sleep,
  };
}

describe("ParakeetSttEngine", () => {
  it("streams and atomically caches the exact pinned files before WebGPU loading", async () => {
    const { engine, factory, fetch, model, objectUrls } = harness();
    const progress: Array<Record<string, unknown>> = [];

    await engine.init((event) => progress.push({ ...event }));

    expect(fetch).toHaveBeenCalledTimes(3);
    for (const [index, file] of Object.keys(TEST_SIZES).entries()) {
      expect(String(fetch.mock.calls[index]?.[0])).toBe(
        `https://huggingface.co/efederici/` +
          `parakeet-tdt-0.6b-v3-onnx-int4/resolve/` +
          `${PARAKEET_MODEL_REVISION}/${file}`,
      );
    }
    expect(progress).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "downloading",
          loaded: 4,
          total: 9,
        }),
        expect.objectContaining({
          status: "validating",
          loaded: 9,
          total: 9,
        }),
        expect.objectContaining({ status: "loading" }),
        expect.objectContaining({ status: "ready" }),
      ]),
    );
    expect(factory).toHaveBeenCalledWith({
      encoderUrl: objectUrls[0],
      decoderUrl: objectUrls[1],
      tokenizerUrl: objectUrls[2],
      backend: "webgpu",
      preprocessorBackend: "js",
      wasmPaths: "chrome-extension://sotto/assets/ort-parakeet/",
      cpuThreads: 1,
    });

    const audio = new Float32Array(16_000).fill(0.1);
    await expect(engine.transcribe(audio)).resolves.toBe("open calendar");
    expect(model.transcribe).toHaveBeenCalledWith(
      audio,
      16_000,
      {
        returnTimestamps: false,
        returnConfidences: true,
        enableProfiling: false,
      },
    );
    await engine.dispose();
    expect(model.dispose).toHaveBeenCalledTimes(1);
  });

  it("rejects a size mismatch without exposing a partially committed model", async () => {
    const { cacheStorage, engine, factory } = harness({
      failFile: "decoder_joint-model.int8.onnx",
    });

    await expect(engine.init()).rejects.toThrow("size mismatch");
    expect(factory).not.toHaveBeenCalled();
    const committed = [...cacheStorage.caches.entries()].find(([name]) =>
      !name.includes("-staging-")
    )?.[1];
    expect(
      [...(committed?.entries.keys() ?? [])].some((key) =>
        key.includes("sotto-cache-manifest")
      ),
    ).toBe(false);
  });

  it("requests the saved offset and includes it in resumed progress", async () => {
    let encoderRequests = 0;
    const setup = harness({
      fetch: async (input, init) => {
        const name = String(input).split("/").at(-1) as keyof typeof TEST_SIZES;
        const range = new Headers(init?.headers).get("range");
        if (name === "encoder-model.int4.onnx") {
          encoderRequests += 1;
          if (encoderRequests === 1) {
            return new Response(interruptedBody(2), {
              status: 200,
              headers: {
                "accept-ranges": "bytes",
                "content-length": "4",
              },
            });
          }
          expect(range).toBe("bytes=2-");
          return new Response(new Uint8Array(2), {
            status: 206,
            headers: {
              "content-length": "2",
              "content-range": "bytes 2-3/4",
            },
          });
        }
        const size = TEST_SIZES[name];
        return new Response(new Uint8Array(size), {
          headers: {
            "accept-ranges": "bytes",
            "content-length": String(size),
          },
        });
      },
    });
    const progress: Array<Record<string, unknown>> = [];

    await setup.engine.init((event) => progress.push({ ...event }));

    expect(setup.fetch).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("encoder-model.int4.onnx"),
      expect.objectContaining({
        headers: { Range: "bytes=2-" },
      }),
    );
    expect(progress).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: "encoder-model.int4.onnx",
          loaded: 2,
          total: 9,
          progress: 2 / 9,
          resumable: true,
        }),
      ]),
    );
    const committed = [...setup.cacheStorage.caches.entries()].find(
      ([name]) => !name.endsWith("-staging"),
    )?.[1];
    expect(
      [...(committed?.entries.keys() ?? [])].some((key) =>
        key.includes("sotto-cache-manifest")
      ),
    ).toBe(true);
  });

  it("restarts a partial file when a Range request returns 200", async () => {
    let encoderRequests = 0;
    const progress: number[] = [];
    const setup = harness({
      fetch: async (input, init) => {
        const name = String(input).split("/").at(-1) as keyof typeof TEST_SIZES;
        const range = new Headers(init?.headers).get("range");
        if (name === "encoder-model.int4.onnx") {
          encoderRequests += 1;
          if (encoderRequests === 1) {
            return new Response(interruptedBody(2), {
              headers: {
                "accept-ranges": "bytes",
                "content-length": "4",
              },
            });
          }
          expect(range).toBe("bytes=2-");
          return new Response(new Uint8Array(4), {
            status: 200,
            headers: { "content-length": "4" },
          });
        }
        const size = TEST_SIZES[name];
        return new Response(new Uint8Array(size), {
          headers: { "content-length": String(size) },
        });
      },
    });

    await setup.engine.init((event) => {
      if (
        event.status === "downloading" &&
        event.file === "encoder-model.int4.onnx" &&
        typeof event.loaded === "number"
      ) {
        progress.push(event.loaded);
      }
    });

    expect(progress).toContain(2);
    expect(progress).toContain(4);
    expect(setup.objectUrls[0]).toBe("blob:test-4-0");
  });

  it("restarts without Range when the server omits Accept-Ranges", async () => {
    let encoderRequests = 0;
    const setup = harness({
      fetch: async (input, init) => {
        const name = String(input).split("/").at(-1) as keyof typeof TEST_SIZES;
        if (name === "encoder-model.int4.onnx") {
          encoderRequests += 1;
          if (encoderRequests === 1) {
            return new Response(interruptedBody(2), {
              headers: { "content-length": "4" },
            });
          }
          expect(new Headers(init?.headers).get("range")).toBeNull();
          return new Response(new Uint8Array(4), {
            headers: { "content-length": "4" },
          });
        }
        const size = TEST_SIZES[name];
        return new Response(new Uint8Array(size), {
          headers: { "content-length": String(size) },
        });
      },
    });

    await setup.engine.init();

    expect(encoderRequests).toBe(2);
  });

  it("rejects a 206 response with the wrong Content-Range", async () => {
    let request = 0;
    const setup = harness({
      fetch: async (input) => {
        const name = String(input).split("/").at(-1) as keyof typeof TEST_SIZES;
        request += 1;
        if (request === 1) {
          return new Response(interruptedBody(2), {
            headers: {
              "accept-ranges": "bytes",
              "content-length": "4",
            },
          });
        }
        return new Response(new Uint8Array(2), {
          status: 206,
          headers: {
            "content-length": "2",
            "content-range": "bytes 1-2/4",
          },
        });
      },
    });

    await expect(setup.engine.init()).rejects.toThrow(
      "invalid Content-Range",
    );
    expect(setup.factory).not.toHaveBeenCalled();
  });

  it("keeps a failed partial without committing the model", async () => {
    let request = 0;
    const setup = harness({
      fetch: async () => {
        request += 1;
        return new Response(interruptedBody(request === 1 ? 2 : 0), {
          headers: {
            "accept-ranges": "bytes",
            "content-length": String(request === 1 ? 4 : 2),
            ...(request > 1
              ? { "content-range": "bytes 2-3/4" }
              : {}),
          },
          status: request > 1 ? 206 : 200,
        });
      },
    });
    const progress: Array<Record<string, unknown>> = [];

    await expect(
      setup.engine.init((event) => progress.push({ ...event })),
    ).rejects.toThrow("connection interrupted");

    expect(setup.fetch).toHaveBeenCalledTimes(3);
    expect(
      [...setup.cacheStorage.caches.keys()].some((name) =>
        name.endsWith("-staging")
      ),
    ).toBe(true);
    for (const [name, cache] of setup.cacheStorage.caches) {
      if (name.endsWith("-staging")) continue;
      expect(
        [...cache.entries.keys()].some((key) =>
          key.includes("sotto-cache-manifest")
        ),
      ).toBe(false);
    }
    expect(progress.at(-1)).toEqual(
      expect.objectContaining({ loaded: 2, resumable: true }),
    );

    const resumed = harness({
      cacheStorage: setup.cacheStorage,
      fetch: async (input, init) => {
        const name = String(input).split("/").at(-1) as keyof typeof TEST_SIZES;
        const range = new Headers(init?.headers).get("range");
        const offset = Number(/^bytes=(\d+)-$/.exec(range ?? "")?.[1] ?? 0);
        const size = TEST_SIZES[name];
        return new Response(new Uint8Array(size - offset), {
          status: offset > 0 ? 206 : 200,
          headers: {
            "accept-ranges": "bytes",
            "content-length": String(size - offset),
            ...(offset > 0
              ? { "content-range": `bytes ${offset}-${size - 1}/${size}` }
              : {}),
          },
        });
      },
    });
    await resumed.engine.init();

    expect(
      new Headers(resumed.fetch.mock.calls[0]?.[1]?.headers).get("range"),
    ).toBe("bytes=2-");
    const committed = [...setup.cacheStorage.caches.entries()].find(
      ([name]) => !name.endsWith("-staging"),
    )?.[1];
    expect(
      [...(committed?.entries.keys() ?? [])].some((key) =>
        key.includes("sotto-cache-manifest")
      ),
    ).toBe(true);
  });

  it("sweeps a partial after seven days", async () => {
    const cacheStorage = new FakeCacheStorage();
    let firstRequest = true;
    const interrupted = harness({
      cacheStorage,
      now: () => 1_000,
      fetch: async () => {
        const body = interruptedBody(firstRequest ? 2 : 0);
        const response = new Response(body, {
          headers: {
            "accept-ranges": "bytes",
            "content-length": firstRequest ? "4" : "2",
            ...(firstRequest
              ? {}
              : { "content-range": "bytes 2-3/4" }),
          },
          status: firstRequest ? 200 : 206,
        });
        firstRequest = false;
        return response;
      },
    });
    await expect(interrupted.engine.init()).rejects.toThrow(
      "connection interrupted",
    );
    const resumed = harness({
      cacheStorage,
      now: () => 1_000 + 8 * 24 * 60 * 60 * 1_000,
    });

    await resumed.engine.init();

    expect(
      new Headers(resumed.fetch.mock.calls[0]?.[1]?.headers).get("range"),
    ).toBeNull();
  });

  it("retries a network failure three times with exponential backoff", async () => {
    let request = 0;
    const setup = harness({
      fetch: async (input) => {
        request += 1;
        if (request < 3) throw new TypeError("network unavailable");
        const name = String(input).split("/").at(-1) as keyof typeof TEST_SIZES;
        const size = TEST_SIZES[name];
        return new Response(new Uint8Array(size), {
          headers: {
            "accept-ranges": "bytes",
            "content-length": String(size),
          },
        });
      },
    });

    await setup.engine.init();

    expect(setup.fetch).toHaveBeenCalledTimes(5);
    expect(setup.sleep).toHaveBeenNthCalledWith(1, 500);
    expect(setup.sleep).toHaveBeenNthCalledWith(2, 1_000);
  });

  it("reloads cheaply from validated CacheStorage without fetching again", async () => {
    const first = harness();
    await first.engine.init();
    await first.engine.dispose();
    first.fetch.mockClear();
    const secondModel = {
      transcribe: vi.fn(),
      dispose: vi.fn().mockResolvedValue(undefined),
    };
    const secondFactory = vi.fn().mockResolvedValue(secondModel);
    const second = new ParakeetSttEngine({
      cacheStorage: first.cacheStorage as unknown as CacheStorage,
      fetch: first.fetch as typeof globalThis.fetch,
      factory: secondFactory,
      runtimeUrl: (path) => `chrome-extension://sotto/${path}`,
      createObjectUrl: (blob) => `blob:cached-${blob.size}`,
      revokeObjectUrl: vi.fn(),
      modelSizes: TEST_SIZES,
    });

    await second.init();

    expect(first.fetch).not.toHaveBeenCalled();
    expect(secondFactory).toHaveBeenCalledTimes(1);
  });

  it("rejects a corrupt manifest instead of activating cached files", async () => {
    const first = harness();
    await first.engine.init();
    await first.engine.dispose();
    const committed = [...first.cacheStorage.caches.entries()].find(([name]) =>
      !name.includes("-staging-")
    )?.[1];
    const manifestUrl = [...(committed?.entries.keys() ?? [])].find((key) =>
      key.includes("sotto-cache-manifest")
    );
    expect(manifestUrl).toBeDefined();
    await committed!.put(
      manifestUrl!,
      new Response(JSON.stringify({ revision: "main" })),
    );
    first.fetch.mockClear();
    const replacement = new ParakeetSttEngine({
      cacheStorage: first.cacheStorage as unknown as CacheStorage,
      fetch: first.fetch as typeof globalThis.fetch,
      factory: vi.fn().mockResolvedValue(first.model),
      runtimeUrl: (path) => `chrome-extension://sotto/${path}`,
      createObjectUrl: (blob) => `blob:revalidated-${blob.size}`,
      revokeObjectUrl: vi.fn(),
      modelSizes: TEST_SIZES,
    });

    await replacement.init();

    expect(first.fetch).toHaveBeenCalledTimes(3);
  });
});
