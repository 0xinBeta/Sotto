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

function harness(options: {
  readonly sizes?: typeof TEST_SIZES;
  readonly failFile?: string;
  readonly interruptFile?: string;
} = {}) {
  const cacheStorage = new FakeCacheStorage();
  const model = {
    transcribe: vi.fn().mockResolvedValue({
      utterance_text: "  open calendar  ",
      tokens: [{ token: "open" }, { token: "calendar" }],
    }),
    dispose: vi.fn().mockResolvedValue(undefined),
  };
  const factory = vi.fn().mockResolvedValue(model);
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const name = String(input).split("/").at(-1) as keyof typeof TEST_SIZES;
    const expected = (options.sizes ?? TEST_SIZES)[name];
    const declared = name === options.failFile ? expected + 1 : expected;
    const body = name === options.interruptFile
      ? new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(Math.max(1, expected - 1)));
            controller.error(new Error("connection interrupted"));
          },
        })
      : new Uint8Array(expected);
    return new Response(body, {
      status: 200,
      headers: {
        "content-length": String(declared),
        "content-type": name === "vocab.txt"
          ? "text/plain"
          : "application/octet-stream",
      },
    });
  });
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
  });
  return { cacheStorage, engine, factory, fetch, model, objectUrls };
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

  it.each(Object.keys(TEST_SIZES))(
    "never commits a manifest when %s is interrupted",
    async (interruptFile) => {
      const { cacheStorage, engine, factory } = harness({ interruptFile });

      await expect(engine.init()).rejects.toThrow("connection interrupted");
      expect(factory).not.toHaveBeenCalled();
      for (const [name, cache] of cacheStorage.caches) {
        expect(name).not.toContain("-staging-");
        expect(
          [...cache.entries.keys()].some((key) =>
            key.includes("sotto-cache-manifest")
          ),
        ).toBe(false);
      }
    },
  );

  it("removes an orphaned staging cache before a recreated download", async () => {
    const setup = harness();
    const staleName =
      `sotto-parakeet-${PARAKEET_MODEL_REVISION}-staging-orphan`;
    setup.cacheStorage.caches.set(staleName, new FakeCache());

    await setup.engine.init();

    expect(setup.cacheStorage.caches.has(staleName)).toBe(false);
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
