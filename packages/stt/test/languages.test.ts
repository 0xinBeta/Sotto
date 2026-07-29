import { describe, expect, it } from "vitest";

import {
  normalizeSpeechLanguage,
  PARAKEET_SPEECH_LANGUAGES,
} from "../src/index.js";

describe("Parakeet speech languages", () => {
  it("matches the 25 languages in the NVIDIA model card", () => {
    expect(PARAKEET_SPEECH_LANGUAGES.map(({ code }) => code)).toEqual([
      "bg",
      "hr",
      "cs",
      "da",
      "nl",
      "en",
      "et",
      "fi",
      "fr",
      "de",
      "el",
      "hu",
      "it",
      "lv",
      "lt",
      "mt",
      "pl",
      "pt",
      "ro",
      "sk",
      "sl",
      "es",
      "sv",
      "ru",
      "uk",
    ]);
    expect(normalizeSpeechLanguage("invalid")).toBe("auto");
  });
});
