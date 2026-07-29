import { describe, expect, it } from "vitest";

import { normalizeSpeechLanguage } from "@sotto/stt/languages";
import {
  isNonEnglishSpeech,
  speechLanguageControl,
  speechLanguageForTier,
} from "../src/stt-language.js";

describe("speech language settings", () => {
  it("uses Auto by default and fixes Moonshine to English", () => {
    expect(normalizeSpeechLanguage(undefined)).toBe("auto");
    expect(speechLanguageForTier("parakeet", undefined)).toBe("auto");
    expect(speechLanguageForTier("moonshine-base", "es")).toBe("en");
  });

  it("shows a select for Parakeet and fixed English for Moonshine", () => {
    expect(speechLanguageControl("parakeet")).toBe("select");
    expect(speechLanguageControl("moonshine-base")).toBe("english-fixed");
  });

  it("guards selected and clearly detected non-English speech", () => {
    expect(isNonEnglishSpeech("es", "abre una pestaña")).toBe(true);
    expect(isNonEnglishSpeech("auto", "Привіт, відкрий вкладку")).toBe(true);
    expect(isNonEnglishSpeech("auto", "open a new tab")).toBe(false);
    expect(isNonEnglishSpeech("en", "café notes")).toBe(false);
  });
});
