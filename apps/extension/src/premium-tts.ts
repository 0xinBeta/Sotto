import type {
  LongFormTtsEngine,
  TtsLongSpeakOptions,
  TtsSpeakOptions,
} from "@sotto/tts";
import {
  KOKORO_VOICE,
  type KokoroVoiceId,
} from "@sotto/tts/kokoro";

export const PREMIUM_TTS_ENABLED_KEY = "premiumTtsEnabled";
export const PREMIUM_TTS_DOWNLOADED_KEY = "premiumTtsDownloaded";
export const PREMIUM_TTS_VOICE_KEY = "premiumTtsVoice";
export const PREMIUM_FIRST_AUDIO_TIMEOUT_MS = 750;
export const PREMIUM_TTS_PREVIEW_TEXT = "This is my Sotto voice.";

const IDLE_RETRY_DELAY_MS = 5_000;
const MAX_SENTENCE_CHARACTERS = 200;
const SENTENCE_ABBREVIATIONS = new Set([
  "capt",
  "col",
  "dept",
  "dr",
  "etc",
  "gen",
  "gov",
  "inc",
  "jr",
  "lt",
  "maj",
  "mr",
  "mrs",
  "ms",
  "prof",
  "rep",
  "sen",
  "sgt",
  "sr",
  "st",
  "vs",
]);

export type PremiumTtsState =
  | "absent"
  | "downloading"
  | "ready"
  | "error";

export interface PremiumTtsStatus {
  readonly state: PremiumTtsState;
  readonly enabled: boolean;
  readonly voice?: KokoroVoiceId;
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
  readonly voice?: KokoroVoiceId;
  readonly preview?: boolean;
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
  cancel(): void;
  notify(): void;
}

export interface PremiumVoiceSelectionOptions {
  readonly voice: KokoroVoiceId;
  readonly previousVoice: KokoroVoiceId;
  readonly persist: (voice: KokoroVoiceId) => Promise<void>;
  readonly speak: (
    text: string,
    voice: KokoroVoiceId,
  ) => Promise<void>;
}

export async function previewPremiumVoiceSelection(
  options: PremiumVoiceSelectionOptions,
): Promise<void> {
  await options.persist(options.voice);
  try {
    await options.speak(PREMIUM_TTS_PREVIEW_TEXT, options.voice);
  } catch (error) {
    await options.persist(options.previousVoice);
    throw error;
  }
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

  const sentences: string[] = [];
  let start = 0;
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (
      character !== "." &&
      character !== "!" &&
      character !== "?" &&
      character !== "…"
    ) {
      continue;
    }

    let punctuationEnd = index + 1;
    while (
      punctuationEnd < normalized.length &&
      /[.!?…"'”’)\]]/.test(normalized[punctuationEnd] ?? "")
    ) {
      punctuationEnd += 1;
    }
    let next = punctuationEnd;
    while (next < normalized.length && /\s/.test(normalized[next] ?? "")) {
      next += 1;
    }
    if (next < normalized.length && next === punctuationEnd) continue;

    if (character === "." && next < normalized.length) {
      const tokenStart = normalized.lastIndexOf(" ", index - 1) + 1;
      const token = normalized.slice(tokenStart, index + 1);
      const bareToken = token.replace(/\.+$/, "").toLowerCase();
      if (
        SENTENCE_ABBREVIATIONS.has(bareToken) ||
        /^(?:[A-Za-z]\.){2,}$/.test(token) ||
        (/\d/.test(normalized[index - 1] ?? "") &&
          /\d/.test(normalized[index + 1] ?? "")) ||
        /[a-z]/.test(normalized[next] ?? "")
      ) {
        continue;
      }
    }

    const sentence = normalized.slice(start, punctuationEnd).trim();
    if (/[\p{L}\p{N}]/u.test(sentence)) sentences.push(sentence);
    start = punctuationEnd;
    while (start < normalized.length && /\s/.test(normalized[start] ?? "")) {
      start += 1;
    }
    index = start - 1;
  }

  const remainder = normalized.slice(start).trim();
  if (/[\p{L}\p{N}]/u.test(remainder)) sentences.push(remainder);
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
  #voice: KokoroVoiceId = KOKORO_VOICE;

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

  get voice(): KokoroVoiceId {
    return this.#voice;
  }

  updateStatus(status: PremiumTtsStatus): void {
    const wasReady = this.#state === "ready";
    const wasEnabled = this.#enabled;
    this.#state = status.state;
    this.#enabled = status.enabled;
    if (status.voice !== undefined) this.#voice = status.voice;
    if (!status.enabled || status.state !== "ready") {
      this.#clearRetry();
    } else if (!wasReady) {
      this.#premiumSucceeded();
    } else if (!wasEnabled && this.#circuitOpen) {
      this.#scheduleRetry();
    }
  }

  notifyFirstAudio(utteranceId: string): void {
    this.#waiters.get(utteranceId)?.notify();
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
    let firstAudioEmitted = false;
    const sentenceOptions: TtsLongSpeakOptions = {
      ...options,
      onFirstAudio() {
        if (firstAudioEmitted) return;
        firstAudioEmitted = true;
        options.onFirstAudio?.();
      },
    };

    try {
      for (const [chunkIndex, chunk] of chunks.entries()) {
        if (generation !== this.#generation) return;
        await this.#speakSentence(chunk, sentenceOptions, generation);
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

  async preview(text: string, voice: KokoroVoiceId): Promise<void> {
    const utterance = text.trim();
    if (!utterance) return;
    const generation = this.#begin();
    this.#active = true;
    try {
      await this.#speakSentence(
        utterance,
        {},
        generation,
        voice,
        true,
      );
    } finally {
      if (generation === this.#generation) this.#active = false;
    }
  }

  stop(): void {
    this.#generation += 1;
    this.#active = false;
    this.#system.stop();
    const utteranceIds = [...this.#waiters.keys()];
    for (const waiter of this.#waiters.values()) waiter.cancel();
    this.#waiters.clear();
    for (const utteranceId of utteranceIds) {
      void this.#request({ type: "premium-stop", utteranceId })
        .catch(() => undefined);
    }
  }

  #begin(): number {
    this.stop();
    return this.#generation;
  }

  async #speakSentence(
    text: string,
    options: TtsSpeakOptions,
    generation: number,
    voice = this.#voice,
    premiumOnly = false,
  ): Promise<void> {
    const language = options.lang?.toLowerCase();
    if (
      (premiumOnly
        ? this.#state !== "ready"
        : !this.#shouldUsePremium()) ||
      (language !== undefined &&
        language !== "en" &&
        !language.startsWith("en-"))
    ) {
      if (premiumOnly) {
        throw new Error("Premium voice is not ready");
      }
      await this.#system.speak(text, options);
      return;
    }

    const utteranceId =
      `premium-${Date.now()}-${++this.#utteranceSequence}`;
    let resolveFirst!: () => void;
    let firstAudioSettled = false;
    const firstAudio = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    this.#waiters.set(utteranceId, {
      promise: firstAudio,
      cancel() {
        if (firstAudioSettled) return;
        firstAudioSettled = true;
        resolveFirst();
      },
      notify() {
        if (firstAudioSettled) return;
        firstAudioSettled = true;
        try {
          options.onFirstAudio?.();
        } catch (error) {
          console.warn("Premium TTS first audio callback failed", error);
        }
        resolveFirst();
      },
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
      voice,
      ...(premiumOnly ? { preview: true } : {}),
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
        if (generation !== this.#generation) return;
        this.#premiumSucceeded();
        return;
      }

      await this.#request({ type: "premium-stop", utteranceId })
        .catch(() => undefined);
      if (generation !== this.#generation) return;
      if (premiumOnly) {
        void premium.catch(() => undefined);
        throw new Error("Voice preview failed");
      }
      this.#premiumFailed();
      void premium.catch(() => undefined);
      await this.#system.speak(text, options);
    } catch (error) {
      if (generation !== this.#generation) return;
      if (premiumOnly) throw error;
      this.#premiumFailed();
      if (!firstHeard) {
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
