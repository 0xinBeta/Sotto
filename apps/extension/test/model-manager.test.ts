import { describe, expect, it, vi } from "vitest";

import {
  buildModelInventory,
  deleteManagedModel,
  deriveModelState,
  ModelCacheStore,
  totalModelBytes,
} from "../src/model-manager.js";
import { WAKE_WORD_CACHE_HASH_HEADER } from "../src/wake-word-models.js";

function cacheStorage(
  entries: ReadonlyArray<readonly [string, Response]>,
): CacheStorage {
  const responses = new Map(entries);
  const cache = {
    keys: vi.fn(async () =>
      [...responses.keys()].map((url) => new Request(url))
    ),
    match: vi.fn(async (request: RequestInfo | URL) => {
      const url = request instanceof Request
        ? request.url
        : String(request);
      return responses.get(url)?.clone();
    }),
    delete: vi.fn(async (request: RequestInfo | URL) => {
      const url = request instanceof Request
        ? request.url
        : String(request);
      return responses.delete(url);
    }),
  };
  return {
    keys: vi.fn(async () => ["models"]),
    open: vi.fn(async () => cache),
  } as unknown as CacheStorage;
}

describe("model manager", () => {
  it("derives downloading, active, cached, and absent states", () => {
    expect(deriveModelState({ downloading: true, active: true })).toBe(
      "downloading",
    );
    expect(deriveModelState({ active: true, cached: true })).toBe("active");
    expect(deriveModelState({ cached: true })).toBe("cached");
    expect(deriveModelState({})).toBe("absent");
  });

  it("measures response bytes and aggregates model totals", async () => {
    const store = new ModelCacheStore(cacheStorage([
      [
        "https://huggingface.co/onnx-community/moonshine-tiny-ONNX/resolve/revision/model.onnx",
        new Response(new Uint8Array(3), {
          headers: { "content-length": "120" },
        }),
      ],
      [
        "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/revision/model.onnx",
        new Response(new Uint8Array(30)),
      ],
      [
        "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/revision/voices/af_heart.bin",
        new Response(new Uint8Array(7)),
      ],
      [
        "https://huggingface.co/harvestsu/openwakeword-onnx/resolve/revision/melspectrogram.onnx",
        new Response(new Uint8Array(5), {
          headers: {
            [WAKE_WORD_CACHE_HASH_HEADER]: "verified",
          },
        }),
      ],
    ]));

    const measurement = await store.measure();
    expect(measurement.bytes["moonshine-tiny"]).toBe(120);
    expect(measurement.bytes.kokoro).toBe(30);
    expect(measurement.bytes["wake-word"]).toBe(5);
    expect(measurement.voices.af_heart).toBe(7);

    await store.delete("wake-word");
    expect((await store.measure()).bytes["wake-word"]).toBe(0);

    expect(
      totalModelBytes([
        {
          id: "moonshine-tiny",
          label: "Tiny",
          state: "active",
          readOnly: false,
          bytes: 120,
          canDownload: false,
          canDelete: false,
        },
        {
          id: "kokoro",
          label: "Kokoro",
          state: "cached",
          readOnly: false,
          bytes: 30,
          canDownload: false,
          canDelete: true,
        },
        {
          id: "summarizer",
          label: "Summarizer",
          state: "cached",
          readOnly: true,
          canDownload: false,
          canDelete: false,
        },
      ]),
    ).toBe(150);
  });

  it("falls back before it waits for a lease and clears the cache", async () => {
    const order: string[] = [];
    await deleteManagedModel({
      id: "parakeet-v3",
      active: true,
      fallback: vi.fn(async () => {
        order.push("fallback");
      }),
      release: vi.fn(async () => {
        order.push("release");
        return true;
      }),
      clear: vi.fn(async () => {
        order.push("clear");
      }),
    });
    expect(order).toEqual(["fallback", "release", "clear"]);
  });

  it("never offers delete for tiny or buttons for Chrome models", () => {
    const inventory = buildModelInventory({
      cache: {
        bytes: {
          "moonshine-tiny": 10,
          "moonshine-base": 20,
          "parakeet-v3": 0,
          kokoro: 30,
          "wake-word": 3_685_906,
        },
        voices: {},
      },
      premiumSttTier: "moonshine-base",
      premiumSttState: "ready",
      premiumTtsState: "ready",
      premiumTtsEnabled: false,
      premiumTtsVoice: "af_heart",
      wakeWordEnabled: true,
      wakeWordState: "armed",
      nano: "available",
      summarizer: "downloadable",
    });
    const tiny = inventory.rows.find((row) => row.id === "moonshine-tiny");
    expect(tiny).toMatchObject({
      state: "active",
      canDelete: false,
    });
    for (const id of ["gemini-nano", "summarizer"]) {
      expect(inventory.rows.find((row) => row.id === id)).toMatchObject({
        readOnly: true,
        canDownload: false,
        canDelete: false,
      });
    }
    expect(
      inventory.rows.find((row) => row.id === "wake-word"),
    ).toMatchObject({
      label: "Wake phrase models",
      state: "active",
      bytes: 3_685_906,
      canDownload: false,
      canDelete: true,
    });
  });

  it("shows wake model download and absent states", () => {
    const base = {
      cache: {
        bytes: {
          "moonshine-tiny": 10,
          "moonshine-base": 0,
          "parakeet-v3": 0,
          kokoro: 0,
          "wake-word": 0,
        },
        voices: {},
      },
      premiumSttTier: "moonshine-base" as const,
      premiumSttState: "ready" as const,
      premiumTtsState: "absent" as const,
      premiumTtsEnabled: false,
      premiumTtsVoice: "af_heart",
      wakeWordEnabled: false,
      wakeWordState: "disarmed" as const,
      nano: "available" as const,
      summarizer: "available" as const,
    };
    expect(
      buildModelInventory(base).rows.find(
        (row) => row.id === "wake-word",
      ),
    ).toMatchObject({
      state: "absent",
      canDownload: true,
      canDelete: false,
    });
    expect(
      buildModelInventory({
        ...base,
        wakeWordDownloading: true,
      }).rows.find((row) => row.id === "wake-word"),
    ).toMatchObject({
      state: "downloading",
      canDownload: false,
      canDelete: false,
    });
  });

  it("rejects direct deletion of the floor model", async () => {
    await expect(
      deleteManagedModel({
        id: "moonshine-tiny",
        active: true,
        fallback: vi.fn(),
        release: vi.fn(),
        clear: vi.fn(),
      }),
    ).rejects.toThrow("cannot be deleted");
  });
});
