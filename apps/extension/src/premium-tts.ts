import type {
  LongFormTtsEngine,
  TtsLongSpeakOptions,
  TtsSpeakOptions,
} from "@sotto/tts";

export const PREMIUM_TTS_ENABLED_KEY = "premiumTtsEnabled";
export const PREMIUM_TTS_DOWNLOADED_KEY = "premiumTtsDownloaded";
export const PREMIUM_FIRST_AUDIO_TIMEOUT_MS = 750;

const IDLE_RETRY_DELAY_MS = 5_000;
const MAX_SENTENCE_CHARACTERS = 200;

export type PremiumTtsState =
  | "absent"
  | "downloading"
  | "ready"
  | "error";

export interface PremiumTtsStatus {
  readonly state: PremiumTtsState;
  readonly enabled: boolean;
  readonly backend?: "webgpu" | "wasm";
  readonly error?: string;
}

export interface PremiumTtsRequest {
  readonly type: "premium-speak" | "premium-stop" | "premium-probe";
  readonly utteranceId?: string;
  readonly text?: string;
  readonly lang?: string;
  readonly rate?: number;
  readonly volume?: number;
}

export interface PremiumTtsRouterOptions {
  readonly system: LongFormTtsEngine;
  readonly request: (request: PremiumTtsRequest) => Promise<unknown>;
  readonly timeoutMs?: number;
  readonly retryDelayMs?: number;
  readonly setTimer?: (
    callback: () => void,
    delay: number,
  ) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

interface FirstAudioWaiter {
  readonly promise: Promise<void>;
  resolve(): void;
}

function safeUtf16End(text: string, end: number): number {
  if (end <= 0 || end >= text.length) return end;
  const previous = text.charCodeAt(end - 1);
  const next = text.charCodeAt(end);
  return previous >= 0xd800 &&
      previous <= 0xdbff &&
      next >= 0xdc00 &&
      next <= 0xdfff
    ? end - 1
    : end;
}

function hardCapSentence(sentence: string): string[] {
  const chunks: string[] = [];
  let remaining = sentence.trim();
  while (remaining.length > MAX_SENTENCE_CHARACTERS) {
    const maximum = safeUtf16End(remaining, MAX_SENTENCE_CHARACTERS);
    const candidate = remaining.slice(0, maximum);
    const whitespace = candidate.lastIndexOf(" ");
    const boundary = whitespace >= Math.floor(maximum * 0.55)
      ? whitespace
      : maximum;
    chunks.push(remaining.slice(0, boundary).trim());
    remaining = remaining.slice(boundary).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export function splitPremiumSentences(text: string): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [];

  const sentences =
    normalized.match(/[^.!?…]+(?:[.!?…]+["'”’)\]]*)?|[.!?…]+/g) ??
      [normalized];
  return sentences.flatMap(hardCapSentence).filter(Boolean);
}

export function premiumEnabledByDefault(
  storedEnabled: unknown,
  downloaded: unknown,
): boolean {
  return typeof storedEnabled === "boolean"
    ? storedEnabled
    : downloaded === true;
}

export class PremiumTtsRouter implements LongFormTtsEngine {
  readonly #system: LongFormTtsEngine;
  readonly #request: (request: PremiumTtsRequest) => Promise<unknown>;
  readonly #timeoutMs: number;
  readonly #retryDelayMs: number;
  readonly #setTimer: NonNullable<PremiumTtsRouterOptions["setTimer"]>;
  readonly #clearTimer: NonNullable<PremiumTtsRouterOptions["clearTimer"]>;

  #state: PremiumTtsState = "absent";
  #enabled = false;
  #consecutiveFailures = 0;
  #circuitOpen = false;
  #generation = 0;
  #utteranceSequence = 0;
  #active = false;
  #waiters = new Map<string, FirstAudioWaiter>();
  #retryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: PremiumTtsRouterOptions) {
    this.#system = options.system;
    this.#request = options.request;
    this.#timeoutMs = options.timeoutMs ?? PREMIUM_FIRST_AUDIO_TIMEOUT_MS;
    this.#retryDelayMs = options.retryDelayMs ?? IDLE_RETRY_DELAY_MS;
    this.#setTimer = options.setTimer ?? setTimeout;
    this.#clearTimer = options.clearTimer ?? clearTimeout;
  }

  get state(): PremiumTtsState {
    return this.#state;
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  get consecutiveFailures(): number {
    return this.#consecutiveFailures;
  }

  get circuitOpen(): boolean {
    return this.#circuitOpen;
  }

  updateStatus(status: PremiumTtsStatus): void {
    this.#state = status.state;
    this.#enabled = status.enabled;
    if (!status.enabled || status.state !== "ready") {
      this.#clearRetry();
    }
  }

  notifyFirstAudio(utteranceId: string): void {
    this.#waiters.get(utteranceId)?.resolve();
  }

  async speak(
    text: string,
    options: TtsSpeakOptions = {},
  ): Promise<void> {
    const utterance = text.trim();
    if (!utterance) return;
    const generation = this.#begin();
    this.#active = true;
    try {
      await this.#speakSentence(utterance, options, generation);
    } finally {
      if (generation === this.#generation) this.#active = false;
    }
  }

  async speakLong(
    text: string,
    options: TtsLongSpeakOptions = {},
  ): Promise<void> {
    const chunks = splitPremiumSentences(text);
    if (chunks.length === 0) return;
    const normalized = chunks.join(" ");
    const generation = this.#begin();
    this.#active = true;
    let charIndex = 0;

    try {
      for (const [chunkIndex, chunk] of chunks.entries()) {
        if (generation !== this.#generation) return;
        await this.#speakSentence(chunk, options, generation);
        if (generation !== this.#generation) return;
        charIndex = Math.min(
          normalized.length,
          charIndex + chunk.length + (chunkIndex > 0 ? 1 : 0),
        );
        try {
          options.onProgress?.({
            charIndex,
            totalChars: normalized.length,
            chunkIndex,
            chunkCount: chunks.length,
            chunkCharIndex: chunk.length,
            eventType: "end",
          });
        } catch (error) {
          console.warn("Premium TTS progress callback failed", error);
        }
      }
    } finally {
      if (generation === this.#generation) this.#active = false;
    }
  }

  stop(): void {
    this.#generation += 1;
    this.#active = false;
    this.#system.stop();
    for (const waiter of this.#waiters.values()) waiter.resolve();
    this.#waiters.clear();
    void this.#request({ type: "premium-stop" }).catch(() => undefined);
  }

  #begin(): number {
    this.stop();
    return this.#generation;
  }

  async #speakSentence(
    text: string,
    options: TtsSpeakOptions,
    generation: number,
  ): Promise<void> {
    const language = options.lang?.toLowerCase();
    if (
      !this.#shouldUsePremium() ||
      (language !== undefined &&
        language !== "en" &&
        !language.startsWith("en-"))
    ) {
      await this.#system.speak(text, options);
      return;
    }

    const utteranceId =
      `premium-${Date.now()}-${++this.#utteranceSequence}`;
    let resolveFirst!: () => void;
    const firstAudio = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    this.#waiters.set(utteranceId, {
      promise: firstAudio,
      resolve: resolveFirst,
    });

    let timeout!: ReturnType<typeof setTimeout>;
    const timedOut = new Promise<"timeout">((resolve) => {
      timeout = this.#setTimer(() => resolve("timeout"), this.#timeoutMs);
    });
    const premium = this.#request({
      type: "premium-speak",
      utteranceId,
      text,
      ...(options.lang === undefined ? {} : { lang: options.lang }),
      ...(options.rate === undefined ? {} : { rate: options.rate }),
      ...(options.volume === undefined ? {} : { volume: options.volume }),
    });

    let firstHeard = false;
    try {
      const firstOutcome = await Promise.race([
        firstAudio.then(() => "audio" as const),
        timedOut,
        premium.then(() => "complete" as const),
        premium.catch(() => "failed" as const),
      ]);
      if (generation !== this.#generation) return;

      if (firstOutcome === "audio") {
        firstHeard = true;
        await premium;
        this.#premiumSucceeded();
        return;
      }

      void this.#request({ type: "premium-stop", utteranceId })
        .catch(() => undefined);
      this.#premiumFailed();
      void premium.catch(() => undefined);
      if (generation === this.#generation) {
        await this.#system.speak(text, options);
      }
    } catch {
      this.#premiumFailed();
      if (!firstHeard && generation === this.#generation) {
        await this.#system.speak(text, options);
      }
    } finally {
      this.#clearTimer(timeout);
      this.#waiters.delete(utteranceId);
    }
  }

  #shouldUsePremium(): boolean {
    return this.#enabled && this.#state === "ready" && !this.#circuitOpen;
  }

  #premiumSucceeded(): void {
    this.#consecutiveFailures = 0;
    this.#circuitOpen = false;
    this.#clearRetry();
  }

  #premiumFailed(): void {
    this.#consecutiveFailures += 1;
    if (this.#consecutiveFailures < 2) return;
    this.#circuitOpen = true;
    this.#scheduleRetry();
  }

  #scheduleRetry(): void {
    if (this.#retryTimer !== undefined || !this.#enabled) return;
    this.#retryTimer = this.#setTimer(() => {
      this.#retryTimer = undefined;
      if (this.#active || this.#state !== "ready" || !this.#enabled) {
        this.#scheduleRetry();
        return;
      }
      void this.#request({ type: "premium-probe" })
        .then(() => this.#premiumSucceeded())
        .catch(() => this.#scheduleRetry());
    }, this.#retryDelayMs);
  }

  #clearRetry(): void {
    if (this.#retryTimer === undefined) return;
    this.#clearTimer(this.#retryTimer);
    this.#retryTimer = undefined;
  }
}
