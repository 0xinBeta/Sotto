import { NanoSession } from "./types.js";
import type {
  NanoAvailability,
  NanoError,
  NanoSessionOptions,
  NanoSessionResult,
} from "./types.js";

function languageModelGlobal(): typeof LanguageModel | undefined {
  const candidate = (globalThis as typeof globalThis & {
    LanguageModel?: typeof LanguageModel;
  }).LanguageModel;
  return candidate;
}

export function toNanoError(error: unknown): NanoError {
  if (error instanceof Error || error instanceof DOMException) {
    return {
      name: error.name,
      message: error.message,
      cause: error,
    };
  }

  return {
    name: "Error",
    message: typeof error === "string" ? error : "Unknown Gemini Nano error",
    cause: error,
  };
}

/**
 * Checks Prompt API support without throwing. An absent API, policy denial,
 * unsupported hardware, and failed capability check all degrade to unavailable.
 */
export async function getNanoAvailability(): Promise<NanoAvailability> {
  const api = languageModelGlobal();
  if (!api) return "unavailable";

  try {
    return await api.availability();
  } catch {
    return "unavailable";
  }
}

/**
 * Creates and owns one Prompt API session. Model download must still be
 * initiated from a user activation; NotAllowedError is returned as data.
 */
export async function createNanoSession(
  options: NanoSessionOptions = {},
): Promise<NanoSessionResult> {
  const api = languageModelGlobal();
  if (!api) {
    return {
      ok: false,
      availability: "unavailable",
      error: {
        name: "NotSupportedError",
        message: "Chrome Prompt API is absent",
      },
    };
  }

  let availability: NanoAvailability;
  try {
    availability = await api.availability();
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
      ...(options.initialPrompts === undefined
        ? {}
        : { initialPrompts: options.initialPrompts }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      monitor(monitor) {
        monitor.addEventListener("downloadprogress", (event) => {
          options.onDownloadProgress?.({
            loaded: Math.min(1, Math.max(0, event.loaded)),
            total: 1,
          });
        });
      },
    });

    return {
      ok: true,
      availability,
      session: new NanoSession(model),
    };
  } catch (error) {
    return {
      ok: false,
      availability: await getNanoAvailability(),
      error: toNanoError(error),
    };
  }
}
