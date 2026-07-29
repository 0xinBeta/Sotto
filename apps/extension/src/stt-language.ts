import {
  normalizeSpeechLanguage,
  type SpeechLanguage,
} from "@sotto/stt/languages";

import type { PremiumSttTier } from "./premium-stt.js";

export const SPEECH_LANGUAGE_KEY = "speechLanguage";
export const NON_ENGLISH_COMMAND_LINE =
  "Commands work in English. Dictation works in your language.";

const NON_ENGLISH_MARKERS = new Set([
  "abra",
  "abre",
  "abrir",
  "apri",
  "ava",
  "avaa",
  "een",
  "fane",
  "guia",
  "karticu",
  "neu",
  "nieuw",
  "nova",
  "novu",
  "odpri",
  "onglet",
  "otvori",
  "ouvre",
  "scheda",
  "tabblad",
  "uma",
  "una",
  "uusi",
  "uus",
  "vaheleht",
  "zavihek",
]);

export type SpeechLanguageControl = "select" | "english-fixed";

export function speechLanguageControl(
  tier: PremiumSttTier,
): SpeechLanguageControl {
  return tier === "parakeet" ? "select" : "english-fixed";
}

export function speechLanguageForTier(
  tier: PremiumSttTier,
  stored: unknown,
): SpeechLanguage {
  return tier === "parakeet"
    ? normalizeSpeechLanguage(stored)
    : "en";
}

export function isNonEnglishSpeech(
  language: SpeechLanguage,
  transcript: string,
): boolean {
  if (language !== "auto") return language !== "en";
  if (/(?=[^\x00-\x7F])\p{L}/u.test(transcript)) return true;

  const words = transcript.toLocaleLowerCase("en-US").match(/[a-z]+/gu) ?? [];
  const markers = new Set(
    words.filter((word) => NON_ENGLISH_MARKERS.has(word)),
  );
  return markers.size >= 2;
}
