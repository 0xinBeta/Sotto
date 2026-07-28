import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const transformers = vi.hoisted(() => ({
  env: {
    backends: {
      onnx: {
        wasm: {
          wasmPaths: "",
          numThreads: 0,
        },
      },
    },
    useBrowserCache: false,
  },
  pipeline: vi.fn(),
}));

vi.mock("@huggingface/transformers", () => transformers);

import { MoonshineEngine } from "../src/index.js";

beforeEach(() => {
  transformers.pipeline.mockReset();
  transformers.env.backends.onnx.wasm.wasmPaths = "";
  transformers.env.backends.onnx.wasm.numThreads = 0;
  transformers.env.useBrowserCache = false;
  vi.stubGlobal("chrome", {
    runtime: {
      getURL: vi.fn((path: string) => `chrome-extension://sotto/${path}`),
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("MoonshineEngine fail-soft initialization", () => {
  it("falls back to WASM when the WebGPU pipeline fails", async () => {
    vi.stubGlobal("navigator", {
      gpu: {
        requestAdapter: vi.fn().mockResolvedValue({}),
      },
    });
    const transcriber = vi
      .fn()
      .mockResolvedValue({ text: "  copied to Claude  " });
    transformers.pipeline
      .mockRejectedValueOnce(new Error("WebGPU device lost"))
      .mockResolvedValueOnce(transcriber);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const engine = new MoonshineEngine();
    await engine.init();

    expect(transformers.pipeline).toHaveBeenNthCalledWith(
      1,
      "automatic-speech-recognition",
      "onnx-community/moonshine-tiny-ONNX",
      expect.objectContaining({
        device: "webgpu",
        revision: "a6da1241cd305dcd64eab1edbd615f2bb9aabb95",
        dtype: {
          encoder_model: "fp32",
          decoder_model_merged: "q4",
        },
      }),
    );
    expect(transformers.pipeline).toHaveBeenNthCalledWith(
      2,
      "automatic-speech-recognition",
      "onnx-community/moonshine-tiny-ONNX",
      expect.objectContaining({
        device: "wasm",
        revision: "a6da1241cd305dcd64eab1edbd615f2bb9aabb95",
        dtype: {
          encoder_model: "fp32",
          decoder_model_merged: "q8",
        },
      }),
    );
    expect(warn).toHaveBeenCalledWith(
      "Moonshine WebGPU failed; falling back to WASM",
      expect.any(Error),
    );
    await expect(engine.transcribe(new Float32Array([0.25]))).resolves.toBe(
      "copied to Claude",
    );
  });

  it("allows initialization to be retried after a backend failure", async () => {
    vi.stubGlobal("navigator", {});
    const transcriber = vi.fn().mockResolvedValue({ text: "ready" });
    transformers.pipeline
      .mockRejectedValueOnce(new Error("WASM download failed"))
      .mockResolvedValueOnce(transcriber);

    const engine = new MoonshineEngine();

    await expect(engine.init()).rejects.toThrow("WASM download failed");
    await expect(engine.init()).resolves.toBeUndefined();
    expect(transformers.pipeline).toHaveBeenCalledTimes(2);
    await expect(engine.transcribe(new Float32Array([0.5]))).resolves.toBe(
      "ready",
    );
  });
});
