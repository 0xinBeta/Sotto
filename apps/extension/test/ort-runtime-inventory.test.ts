import { describe, expect, it } from "vitest";

import {
  assertOrtRuntimeInventory,
  ORT_RUNTIME_FILES,
} from "../ort-runtime-inventory.js";

describe("ORT build inventory", () => {
  it("requires one isolated WASM runtime for VAD and wake", () => {
    expect(ORT_RUNTIME_FILES).toEqual({
      "ort-kokoro": [
        "ort-wasm-simd-threaded.jsep.mjs",
        "ort-wasm-simd-threaded.jsep.wasm",
      ],
      "ort-parakeet": [
        "ort-wasm-simd-threaded.jsep.mjs",
        "ort-wasm-simd-threaded.jsep.wasm",
      ],
      "ort-transformers": [
        "ort-wasm-simd-threaded.asyncify.mjs",
        "ort-wasm-simd-threaded.asyncify.wasm",
      ],
      "ort-vad": [
        "ort-wasm-simd-threaded.mjs",
        "ort-wasm-simd-threaded.wasm",
      ],
    });
  });

  it("rejects the former shared runtime set", () => {
    const sharedInventory = Object.fromEntries(
      Object.entries(ORT_RUNTIME_FILES)
        .filter(([directory]) => directory !== "ort-vad")
        .map(([directory, files]) => [directory, [...files]]),
    );

    expect(() => assertOrtRuntimeInventory(sharedInventory)).toThrow(
      "The extension ORT runtime directories",
    );
  });

  it("rejects a JSEP VAD runtime", () => {
    const inventory = Object.fromEntries(
      Object.entries(ORT_RUNTIME_FILES)
        .map(([directory, files]) => [directory, [...files]]),
    );
    inventory["ort-vad"] = [
      "ort-wasm-simd-threaded.jsep.mjs",
      "ort-wasm-simd-threaded.jsep.wasm",
    ];

    expect(() => assertOrtRuntimeInventory(inventory)).toThrow(
      "The extension ORT runtime ort-vad contains",
    );
  });
});
