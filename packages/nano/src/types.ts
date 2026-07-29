import type {
  ActionCommand,
  ActionRegistry,
  ActionResult,
} from "@sotto/core";

export type NanoAvailability = Availability;
export type ResponseVerbosity = "normal" | "brief";

export interface NanoDownloadProgress {
  /** Fraction of the model download completed, clamped to 0..1. */
  readonly loaded: number;
  /** Chrome currently reports a normalized total of 1. */
  readonly total: 1;
}

export interface NanoError {
  readonly name: string;
  readonly message: string;
  readonly cause?: unknown;
}

export interface NanoSessionOptions {
  readonly initialPrompts?: NonNullable<
    LanguageModelCreateOptions["initialPrompts"]
  >;
  readonly expectedInputs?: LanguageModelCreateCoreOptions["expectedInputs"];
  readonly expectedOutputs?: LanguageModelCreateCoreOptions["expectedOutputs"];
  readonly signal?: AbortSignal;
  readonly onDownloadProgress?: (progress: NanoDownloadProgress) => void;
}

export interface NanoSessionReady {
  readonly ok: true;
  readonly availability: Exclude<NanoAvailability, "unavailable">;
  readonly session: NanoSession;
}

export interface NanoSessionUnavailable {
  readonly ok: false;
  readonly availability: NanoAvailability;
  readonly error?: NanoError;
}

export type NanoSessionResult = NanoSessionReady | NanoSessionUnavailable;

/**
 * The narrow session surface used by parsing/responding. Keeping this
 * structural makes those functions easy to exercise without loading Nano.
 */
export type NanoPromptSession = Pick<LanguageModel, "prompt">;

export interface ParserPromptInput {
  readonly registry: ActionRegistry;
  readonly transcript: string;
  readonly memory?: readonly ParserMemoryExchange[];
}

export interface ParserMemoryExchange {
  readonly transcript: string;
  readonly command: ActionCommand;
  readonly resultSummary: string;
}

export interface ParseCommandOptions extends ParserPromptInput {
  readonly session: NanoPromptSession | null | undefined;
  readonly signal?: AbortSignal;
  readonly onError?: (error: NanoError) => void;
}

export interface OneSentenceResponseOptions {
  readonly session: NanoPromptSession | null | undefined;
  readonly command: ActionCommand;
  readonly result: ActionResult;
  readonly verbosity?: ResponseVerbosity;
  readonly signal?: AbortSignal;
  readonly onError?: (error: NanoError) => void;
}

export interface ParserSessionOptions
  extends Omit<NanoSessionOptions, "initialPrompts"> {
  readonly registry: ActionRegistry;
}

export interface ResponderSessionOptions
  extends Omit<NanoSessionOptions, "initialPrompts"> {
  readonly verbosity?: ResponseVerbosity;
}

export class NanoSession {
  #destroyed = false;

  constructor(readonly model: LanguageModel) {}

  get destroyed(): boolean {
    return this.#destroyed;
  }

  prompt(
    input: LanguageModelPrompt,
    options?: LanguageModelPromptOptions,
  ): Promise<string> {
    if (this.#destroyed) {
      return Promise.reject(
        new DOMException("Gemini Nano session has been destroyed", "InvalidStateError"),
      );
    }
    return this.model.prompt(input, options);
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.model.destroy();
  }
}
