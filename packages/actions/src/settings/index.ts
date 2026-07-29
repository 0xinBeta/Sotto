import { defineAction } from "@sotto/core";
import type {
  JsonSchema,
  SpeechSettingsActionServices,
  SpeechSettingsVoice,
} from "@sotto/core";

export const MIN_SPEECH_RATE = 0.5;
export const MAX_SPEECH_RATE = 2;
export const SPEECH_RATE_STEP = 0.25;
export const MIN_SPEECH_VOLUME = 0;
export const MAX_SPEECH_VOLUME = 1;
export const SPEECH_VOLUME_STEP = 0.2;

export type SettingsOperation =
  | "rate-slower"
  | "rate-faster"
  | "rate-normal"
  | "volume-quieter"
  | "volume-louder"
  | "volume-full"
  | "voice"
  | "verbosity-brief"
  | "verbosity-normal";

export type SettingsCommand =
  | {
      readonly action: "settings";
      readonly operation: Exclude<SettingsOperation, "voice">;
    }
  | {
      readonly action: "settings";
      readonly operation: "voice";
      readonly target: string;
    };

function operationSchema(
  operation: Exclude<SettingsOperation, "voice">,
): JsonSchema {
  return {
    type: "object",
    properties: {
      action: { const: "settings" },
      operation: { const: operation },
    },
    required: ["action", "operation"],
    additionalProperties: false,
  };
}

export const settingsSchema = {
  oneOf: [
    operationSchema("rate-slower"),
    operationSchema("rate-faster"),
    operationSchema("rate-normal"),
    operationSchema("volume-quieter"),
    operationSchema("volume-louder"),
    operationSchema("volume-full"),
    {
      type: "object",
      properties: {
        action: { const: "settings" },
        operation: { const: "voice" },
        target: {
          type: "string",
          minLength: 1,
          maxLength: 100,
        },
      },
      required: ["action", "operation", "target"],
      additionalProperties: false,
    },
    operationSchema("verbosity-brief"),
    operationSchema("verbosity-normal"),
  ],
} as const satisfies JsonSchema;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function roundStep(value: number): number {
  return Math.round(value * 100) / 100;
}

export function nextSpeechRate(
  current: number,
  operation: "rate-slower" | "rate-faster" | "rate-normal",
): number {
  if (operation === "rate-normal") return 1;
  const delta = operation === "rate-slower"
    ? -SPEECH_RATE_STEP
    : SPEECH_RATE_STEP;
  return clamp(
    roundStep(current + delta),
    MIN_SPEECH_RATE,
    MAX_SPEECH_RATE,
  );
}

export function nextSpeechVolume(
  current: number,
  operation: "volume-quieter" | "volume-louder" | "volume-full",
): number {
  if (operation === "volume-full") return 1;
  const delta = operation === "volume-quieter"
    ? -SPEECH_VOLUME_STEP
    : SPEECH_VOLUME_STEP;
  return clamp(
    roundStep(current + delta),
    MIN_SPEECH_VOLUME,
    MAX_SPEECH_VOLUME,
  );
}

function normalize(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function editDistance(left: string, right: string): number {
  if (!left.length) return right.length;
  if (!right.length) return left.length;

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitution =
        previous[rightIndex - 1]! +
        (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1);
      current[rightIndex] = Math.min(
        previous[rightIndex]! + 1,
        current[rightIndex - 1]! + 1,
        substitution,
      );
    }
    previous = current;
  }
  return previous[right.length]!;
}

const TARGET_FILLER_WORDS = new Set([
  "switch",
  "to",
  "the",
  "use",
  "voice",
  "please",
  "my",
]);
const BRITISH_WORDS = new Set(["british", "britain", "uk", "gb"]);
const AMERICAN_WORDS = new Set(["american", "america", "us", "usa"]);

function targetAccent(words: readonly string[]): "US" | "GB" | undefined {
  if (words.some((word) => BRITISH_WORDS.has(word))) return "GB";
  if (words.some((word) => AMERICAN_WORDS.has(word))) return "US";
  return undefined;
}

function scoreVoiceMatch(voice: SpeechSettingsVoice, target: string): number {
  const label = normalize(voice.label);
  const id = normalize(voice.id);
  let best = 0;

  for (const candidate of [label, id]) {
    if (candidate === target) best = Math.max(best, 1);
    if (candidate.startsWith(target)) best = Math.max(best, 0.94);
    if (candidate.includes(target)) best = Math.max(best, 0.9);

    const distance = editDistance(target, candidate);
    const similarity =
      1 - distance / Math.max(target.length, candidate.length);
    best = Math.max(best, similarity * 0.78);
  }
  return best;
}

export function findVoiceMatch(
  voices: readonly SpeechSettingsVoice[],
  target: string,
  minimumScore = 0.42,
): SpeechSettingsVoice | undefined {
  const words = normalize(target).split(" ").filter(Boolean);
  if (words.length === 0) return undefined;

  const accent = targetAccent(words);
  const candidates = accent === undefined
    ? voices
    : voices.filter((voice) => voice.accent === accent);
  const name = words.filter((word) =>
    !TARGET_FILLER_WORDS.has(word) &&
    !BRITISH_WORDS.has(word) &&
    !AMERICAN_WORDS.has(word)
  ).join(" ");

  if (!name) return candidates[0];

  let best:
    | { readonly voice: SpeechSettingsVoice; readonly score: number }
    | undefined;
  for (const voice of candidates) {
    const score = scoreVoiceMatch(voice, name);
    if (!best || score > best.score) best = { voice, score };
  }
  return best && best.score >= minimumScore ? best.voice : undefined;
}

function requireServices(
  services: SpeechSettingsActionServices | undefined,
): SpeechSettingsActionServices {
  if (!services) {
    throw new Error("Speech settings are unavailable");
  }
  return services;
}

const settingsAction = defineAction<SettingsCommand>({
  id: "settings",
  title: "Speech settings",
  permissions: ["storage", "tts"],
  schema: settingsSchema,
  examples: [
    {
      say: "speak slower",
      emit: { action: "settings", operation: "rate-slower" },
    },
    {
      say: "speak faster",
      emit: { action: "settings", operation: "rate-faster" },
    },
    {
      say: "normal speed",
      emit: { action: "settings", operation: "rate-normal" },
    },
    {
      say: "quieter",
      emit: { action: "settings", operation: "volume-quieter" },
    },
    {
      say: "louder",
      emit: { action: "settings", operation: "volume-louder" },
    },
    {
      say: "full volume",
      emit: { action: "settings", operation: "volume-full" },
    },
    {
      say: "switch to the British voice",
      emit: {
        action: "settings",
        operation: "voice",
        target: "British",
      },
    },
    {
      say: "use the Emma voice",
      emit: {
        action: "settings",
        operation: "voice",
        target: "Emma",
      },
    },
    {
      say: "be brief",
      emit: { action: "settings", operation: "verbosity-brief" },
    },
    {
      say: "be normal",
      emit: { action: "settings", operation: "verbosity-normal" },
    },
  ],
  confirm: false,
  async execute(command, context) {
    const services = requireServices(context.settings);
    const settings = await services.get();

    switch (command.operation) {
      case "rate-slower":
      case "rate-faster":
      case "rate-normal":
        await services.setRate(
          nextSpeechRate(settings.rate, command.operation),
        );
        return { spoken: "This is my speed now." };
      case "volume-quieter":
      case "volume-louder":
      case "volume-full":
        await services.setVolume(
          nextSpeechVolume(settings.volume, command.operation),
        );
        return { spoken: "This is my volume now." };
      case "voice": {
        const voice = findVoiceMatch(settings.voices, command.target);
        if (!voice) return { spoken: "I could not find that voice." };
        await services.setVoice(voice.id);
        return { spoken: "This is my voice now." };
      }
      case "verbosity-brief":
        await services.setVerbosity("brief");
        return { spoken: "Brief mode is on." };
      case "verbosity-normal":
        await services.setVerbosity("normal");
        return { spoken: "I will use normal responses now." };
    }
  },
});

export default settingsAction;
