export const ORT_RUNTIME_FILES = {
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
} as const;

export function assertOrtRuntimeInventory(
  actual: Readonly<Record<string, readonly string[]>>,
): void {
  const expectedDirectories = Object.keys(ORT_RUNTIME_FILES).sort();
  const actualDirectories = Object.keys(actual).sort();
  if (actualDirectories.join("\n") !== expectedDirectories.join("\n")) {
    throw new Error(
      `The extension ORT runtime directories are ${actualDirectories.join(", ")}`,
    );
  }

  for (const directory of expectedDirectories) {
    const expected = [...ORT_RUNTIME_FILES[
      directory as keyof typeof ORT_RUNTIME_FILES
    ]].sort();
    const files = [...(actual[directory] ?? [])].sort();
    if (files.join("\n") !== expected.join("\n")) {
      throw new Error(
        `The extension ORT runtime ${directory} contains ${files.join(", ")}`,
      );
    }
  }
}
