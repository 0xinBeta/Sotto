import { toNanoError } from "./session.js";
import type { NanoError } from "./types.js";

export type TranslatorAvailability = Availability;

export interface TranslatorLanguagePair {
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
}

export interface TranslatorDownloadProgress {
  /** Fraction of the model download completed, clamped to 0..1. */
  readonly loaded: number;
  /** Chrome reports a normalized total of 1. */
  readonly total: 1;
}

export interface TranslatorSessionOptions extends TranslatorLanguagePair {
  readonly signal?: AbortSignal;
  readonly onDownloadProgress?: (
    progress: TranslatorDownloadProgress,
  ) => void;
}

export interface TranslatorSessionReady {
  readonly ok: true;
  readonly availability: Exclude<
    TranslatorAvailability,
    "unavailable"
  >;
  readonly session: BuiltInTranslatorSession;
}

export interface TranslatorSessionUnavailable {
  readonly ok: false;
  readonly availability: TranslatorAvailability;
  readonly error?: NanoError;
}

export type TranslatorSessionResult =
  | TranslatorSessionReady
  | TranslatorSessionUnavailable;

export interface DetectSourceLanguageOptions {
  readonly fallbackLanguage?: string;
  readonly signal?: AbortSignal;
  readonly onDownloadProgress?: (
    progress: TranslatorDownloadProgress,
  ) => void;
}

function translatorGlobal(): typeof Translator | undefined {
  return (
    globalThis as typeof globalThis & {
      readonly Translator?: typeof Translator;
    }
  ).Translator;
}

function languageDetectorGlobal(): typeof LanguageDetector | undefined {
  return (
    globalThis as typeof globalThis & {
      readonly LanguageDetector?: typeof LanguageDetector;
    }
  ).LanguageDetector;
}

function pairOptions(
  pair: TranslatorLanguagePair,
): TranslatorLanguagePair {
  return {
    sourceLanguage: pair.sourceLanguage.trim(),
    targetLanguage: pair.targetLanguage.trim(),
  };
}

function reportProgress(
  callback: TranslatorSessionOptions["onDownloadProgress"],
  loaded: number,
): void {
  callback?.({
    loaded: Math.min(1, Math.max(0, loaded)),
    total: 1,
  });
}

/**
 * Converts page language metadata to a language code accepted by Chrome.
 * Chrome uses zh-Hant for Traditional Chinese and base tags for other pairs.
 */
export function normalizeTranslatorLanguage(
  value: string | undefined,
): string | undefined {
  const parts = value
    ?.trim()
    .replaceAll("_", "-")
    .split("-")
    .filter(Boolean);
  if (!parts) return undefined;
  const base = parts[0]?.toLowerCase();
  if (!base || !/^[a-z]{2,3}$/.test(base)) return undefined;
  if (base !== "zh") return base;

  const variants = new Set(parts.slice(1).map((part) => part.toLowerCase()));
  return (
      variants.has("hant") ||
      variants.has("tw") ||
      variants.has("hk") ||
      variants.has("mo")
    )
    ? "zh-Hant"
    : "zh";
}

/**
 * Checks one source and target language pair. Chrome keeps download state
 * private per site, so a new pair can report downloadable until creation.
 */
export async function getTranslatorAvailability(
  pair: TranslatorLanguagePair,
): Promise<TranslatorAvailability> {
  const api = translatorGlobal();
  if (!api) return "unavailable";

  try {
    return await api.availability(pairOptions(pair));
  } catch {
    return "unavailable";
  }
}

export class BuiltInTranslatorSession {
  #destroyed = false;

  constructor(readonly model: Translator) {}

  get destroyed(): boolean {
    return this.#destroyed;
  }

  translate(
    text: string,
    options?: TranslatorTranslateOptions,
  ): Promise<string> {
    if (this.#destroyed) {
      return Promise.reject(
        new DOMException(
          "Translator session has been destroyed",
          "InvalidStateError",
        ),
      );
    }
    return this.model.translate(text, options);
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.model.destroy();
  }
}

/**
 * Creates one translator for a language pair. A downloadable pair starts its
 * model download during create(), after a user command.
 */
export async function createTranslatorSession(
  options: TranslatorSessionOptions,
): Promise<TranslatorSessionResult> {
  const api = translatorGlobal();
  if (!api) {
    return {
      ok: false,
      availability: "unavailable",
      error: {
        name: "NotSupportedError",
        message: "Chrome Translator API is absent",
      },
    };
  }

  const pair = pairOptions(options);
  let availability: TranslatorAvailability;
  try {
    availability = await api.availability(pair);
  } catch (error) {
    return {
      ok: false,
      availability: "unavailable",
      error: toNanoError(error),
    };
  }
  if (availability === "unavailable") {
    return { ok: false, availability };
  }

  try {
    const model = await api.create({
      ...pair,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      monitor(monitor) {
        monitor.addEventListener("downloadprogress", (event) => {
          reportProgress(options.onDownloadProgress, event.loaded);
        });
      },
    });
    return {
      ok: true,
      availability,
      session: new BuiltInTranslatorSession(model),
    };
  } catch (error) {
    return {
      ok: false,
      availability: await getTranslatorAvailability(pair),
      error: toNanoError(error),
    };
  }
}

/**
 * Detects source text when Chrome supports the detector. If detection cannot
 * run, this function uses the page language and then English.
 */
export async function detectSourceLanguage(
  text: string,
  options: DetectSourceLanguageOptions = {},
): Promise<string> {
  const fallback =
    normalizeTranslatorLanguage(options.fallbackLanguage) ?? "en";
  const api = languageDetectorGlobal();
  if (!api) return fallback;

  try {
    if ((await api.availability()) === "unavailable") return fallback;
    const detector = await api.create({
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      monitor(monitor) {
        monitor.addEventListener("downloadprogress", (event) => {
          reportProgress(options.onDownloadProgress, event.loaded);
        });
      },
    });
    try {
      const result = await detector.detect(text, {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      return (
        normalizeTranslatorLanguage(result[0]?.detectedLanguage) ?? fallback
      );
    } finally {
      detector.destroy();
    }
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return fallback;
  }
}
