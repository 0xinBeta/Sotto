export const PARAKEET_SPEECH_LANGUAGES = [
  { code: "bg", label: "Bulgarian" },
  { code: "hr", label: "Croatian" },
  { code: "cs", label: "Czech" },
  { code: "da", label: "Danish" },
  { code: "nl", label: "Dutch" },
  { code: "en", label: "English" },
  { code: "et", label: "Estonian" },
  { code: "fi", label: "Finnish" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "el", label: "Greek" },
  { code: "hu", label: "Hungarian" },
  { code: "it", label: "Italian" },
  { code: "lv", label: "Latvian" },
  { code: "lt", label: "Lithuanian" },
  { code: "mt", label: "Maltese" },
  { code: "pl", label: "Polish" },
  { code: "pt", label: "Portuguese" },
  { code: "ro", label: "Romanian" },
  { code: "sk", label: "Slovak" },
  { code: "sl", label: "Slovenian" },
  { code: "es", label: "Spanish" },
  { code: "sv", label: "Swedish" },
  { code: "ru", label: "Russian" },
  { code: "uk", label: "Ukrainian" },
] as const;

export type ParakeetSpeechLanguage =
  typeof PARAKEET_SPEECH_LANGUAGES[number]["code"];
export type SpeechLanguage = "auto" | ParakeetSpeechLanguage;

const SPEECH_LANGUAGES = new Set<string>([
  "auto",
  ...PARAKEET_SPEECH_LANGUAGES.map(({ code }) => code),
]);

export function isSpeechLanguage(
  value: unknown,
): value is SpeechLanguage {
  return typeof value === "string" && SPEECH_LANGUAGES.has(value);
}

export function normalizeSpeechLanguage(
  value: unknown,
): SpeechLanguage {
  return isSpeechLanguage(value) ? value : "auto";
}
