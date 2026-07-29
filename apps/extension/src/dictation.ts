export const DICTATION_SILENCE_MS = 60_000;

const EXIT_PHRASE =
  /\b(?:(?:stop|end|exit|finish|cancel|leave)\s+dictation(?:\s+mode)?|turn\s+off\s+dictation)\b/iu;
const PLAYBACK_STOP_PHRASE =
  /^(?:stop|stop\s+(?:reading|playback))[\s.!?]*$/iu;
const PUNCTUATION_WORDS = /[ \t]*\bnew\s+(paragraph|line)\b[ \t]*/giu;

export type DictationState = "inactive" | "active" | "paused";

export interface DictationTarget {
  readonly tabId: number;
  readonly frameId: number;
  readonly documentId?: string;
  readonly targetId: string;
}

export function isDictationExitPhrase(transcript: string): boolean {
  return EXIT_PHRASE.test(transcript);
}

export function isPlaybackStopPhrase(transcript: string): boolean {
  return PLAYBACK_STOP_PHRASE.test(transcript.trim());
}

export function formatDictationText(transcript: string): string {
  return transcript.replace(
    PUNCTUATION_WORDS,
    (_match, kind: string) => kind.toLocaleLowerCase("en-US") === "paragraph"
      ? "\n\n"
      : "\n",
  );
}

export function isSameDictationTarget(
  expected: DictationTarget,
  current: DictationTarget,
): boolean {
  return (
    expected.tabId === current.tabId &&
    expected.frameId === current.frameId &&
    expected.documentId === current.documentId &&
    expected.targetId === current.targetId
  );
}

export class DictationTargetSession {
  #state: DictationState = "inactive";
  #target: DictationTarget | undefined;

  get state(): DictationState {
    return this.#state;
  }

  get target(): DictationTarget | undefined {
    return this.#target;
  }

  start(target: DictationTarget): void {
    this.#target = target;
    this.#state = "active";
  }

  validate(current: DictationTarget): boolean {
    if (!this.#target || !isSameDictationTarget(this.#target, current)) {
      if (this.#target) this.#state = "paused";
      return false;
    }
    return true;
  }

  pause(): void {
    if (this.#target) this.#state = "paused";
  }

  resume(current: DictationTarget): boolean {
    if (!this.validate(current)) return false;
    this.#state = "active";
    return true;
  }

  stop(): DictationTarget | undefined {
    const target = this.#target;
    this.#target = undefined;
    this.#state = "inactive";
    return target;
  }
}

export interface DictationTranscriptHandlers<T> {
  readonly parse: (transcript: string) => Promise<T>;
  readonly insert: (text: string) => Promise<T>;
  readonly exit: () => Promise<T>;
  readonly stopPlayback: () => Promise<T>;
}

export async function routeTranscriptForMode<T>(
  state: DictationState,
  transcript: string,
  handlers: DictationTranscriptHandlers<T>,
): Promise<T> {
  if (state === "inactive") return handlers.parse(transcript);
  if (isDictationExitPhrase(transcript)) return handlers.exit();
  if (isPlaybackStopPhrase(transcript)) return handlers.stopPlayback();
  return handlers.insert(formatDictationText(transcript));
}

export class DictationSilenceTimer {
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    readonly onTimeout: () => void,
    readonly delayMs = DICTATION_SILENCE_MS,
  ) {}

  reset(): void {
    this.clear();
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.onTimeout();
    }, this.delayMs);
  }

  clear(): void {
    if (this.#timer === undefined) return;
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}
