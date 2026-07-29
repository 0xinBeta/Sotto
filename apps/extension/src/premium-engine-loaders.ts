export type KokoroTtsEngineConstructor =
  typeof import("@sotto/tts/kokoro")["KokoroTtsEngine"];
export type ParakeetSttEngineConstructor =
  typeof import("@sotto/stt/parakeet")["ParakeetSttEngine"];

export async function loadKokoroTtsEngine(): Promise<
  KokoroTtsEngineConstructor
> {
  return (await import("@sotto/tts/kokoro")).KokoroTtsEngine;
}

export async function loadParakeetSttEngine(): Promise<
  ParakeetSttEngineConstructor
> {
  return (await import("@sotto/stt/parakeet")).ParakeetSttEngine;
}
