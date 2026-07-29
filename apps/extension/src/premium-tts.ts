import type {
  LongFormTtsEngine,
  TtsLongSpeakOptions,
  TtsPlaybackState,
  TtsSpeakOptions,
} from "@sotto/tts";
import {
  KOKORO_VOICE,
  type KokoroVoiceId,
} from "@sotto/tts/kokoro";
import { createReadingPlan } from "./reading-progress.js";

export { splitReadingChunks as splitPremiumSentences } from "./reading-progress.js";

export const PREMIUM_TTS_ENABLED_KEY = "premiumTtsEnabled";
export const PREMIUM_TTS_DOWNLOADED_KEY = "premiumTtsDownloaded";
export const PREMIUM_TTS_VOICE_KEY = "premiumTtsVoice";
export const PREMIUM_FIRST_AUDIO_TIMEOUT_MS = 750;
export const PREMIUM_TTS_PREVIEW_TEXT = "This is my Sotto voice.";

const IDLE_RETRY_DELAY_MS = 5_000;

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
  #playbackState: TtsPlaybackState = "idle";
  #activeLongGeneration: number | undefined;
  #activeLongEngine: "premium" | "system" | undefined;
  #activePremiumUtteranceId: string | undefined;
  #pendingSkips = 0;
  #resumeLong: (() => void) | undefined;
  #controlStops = new Map<string, () => void>();

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

  get playbackState(): TtsPlaybackState {
    return this.#playbackState;
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
    const plan = createReadingPlan(text);
    const chunks = plan.chunks;
    if (chunks.length === 0) return;
    const generation = this.#begin();
    this.#active = true;
    this.#activeLongGeneration = generation;
    this.#playbackState = "playing";
    let firstAudioEmitted = false;
    const { onProgress, ...speakOptions } = options;
    const sentenceOptions: TtsLongSpeakOptions = {
      ...speakOptions,
      onFirstAudio() {
        if (firstAudioEmitted) return;
        firstAudioEmitted = true;
        options.onFirstAudio?.();
      },
    };
    const reportProgress = (
      chunkIndex: number,
      eventType: "start" | "sentence" | "end",
    ): void => {
      const chunk = chunks[chunkIndex];
      if (!chunk) return;
      try {
        onProgress?.({
          charIndex: eventType === "end" ? chunk.end : chunk.start,
          totalChars: plan.text.length,
          chunkIndex,
          chunkCount: chunks.length,
          chunkCharIndex: eventType === "end" ? chunk.text.length : 0,
          eventType,
        });
      } catch (error) {
        console.warn("Premium TTS progress callback failed", error);
      }
    };

    try {
      for (const [chunkIndex, chunk] of chunks.entries()) {
        await this.#waitUntilResumed(generation);
        if (generation !== this.#generation) return;
        if (this.#pendingSkips > 0) {
          this.#pendingSkips -= 1;
        } else {
          reportProgress(
            chunkIndex,
            chunkIndex === 0 ? "start" : "sentence",
          );
          await this.#speakSentence(
            chunk.text,
            sentenceOptions,
            generation,
            undefined,
            false,
            true,
          );
        }
        if (generation !== this.#generation) return;
        reportProgress(chunkIndex, "end");
      }
    } finally {
      if (generation === this.#generation) {
        this.#active = false;
        this.#activeLongGeneration = undefined;
        this.#activeLongEngine = undefined;
        this.#activePremiumUtteranceId = undefined;
        this.#pendingSkips = 0;
        this.#playbackState = "idle";
        this.#resumeLong?.();
        this.#resumeLong = undefined;
      }
    }
  }

  async preview(
    text: string,
    voice: KokoroVoiceId,
    options: TtsSpeakOptions = {},
  ): Promise<void> {
    const utterance = text.trim();
    if (!utterance) return;
    const generation = this.#begin();
    this.#active = true;
    try {
      await this.#speakSentence(
        utterance,
        options,
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
    this.#activeLongGeneration = undefined;
    this.#activeLongEngine = undefined;
    this.#activePremiumUtteranceId = undefined;
    this.#pendingSkips = 0;
    this.#playbackState = "idle";
    this.#resumeLong?.();
    this.#resumeLong = undefined;
    this.#system.stop();
    const utteranceIds = [...this.#waiters.keys()];
    for (const waiter of this.#waiters.values()) waiter.cancel();
    this.#waiters.clear();
    for (const stop of this.#controlStops.values()) stop();
    this.#controlStops.clear();
    for (const utteranceId of utteranceIds) {
      void this.#request({ type: "premium-stop", utteranceId })
        .catch(() => undefined);
    }
  }

  pause(): boolean {
    if (
      this.#activeLongGeneration !== this.#generation ||
      this.#playbackState !== "playing"
    ) {
      return false;
    }
    this.#playbackState = "paused";
    if (this.#activeLongEngine === "system") {
      this.#system.pause();
    } else if (this.#activeLongEngine === "premium") {
      this.#stopActivePremium();
    }
    return true;
  }

  resume(): boolean {
    if (
      this.#activeLongGeneration !== this.#generation ||
      this.#playbackState !== "paused"
    ) {
      return false;
    }
    if (this.#activeLongEngine === "system") {
      this.#system.resume();
    }
    this.#playbackState = "playing";
    this.#resumeLong?.();
    this.#resumeLong = undefined;
    return true;
  }

  skip(): boolean {
    if (
      this.#activeLongGeneration !== this.#generation ||
      this.#playbackState === "idle"
    ) {
      return false;
    }
    if (this.#activeLongEngine === "system") {
      this.#system.skip();
    } else if (this.#activeLongEngine === "premium") {
      if (this.#playbackState === "paused") {
        this.#pendingSkips += 1;
      }
      this.#stopActivePremium();
    } else {
      this.#pendingSkips += 1;
      this.#resumeLong?.();
      this.#resumeLong = undefined;
    }
    return true;
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
    longForm = false,
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
      await this.#speakSystem(text, options, longForm);
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
    let resolveControlStop!: () => void;
    const controlStop = new Promise<"controlled">((resolve) => {
      resolveControlStop = () => resolve("controlled");
    });
    this.#controlStops.set(utteranceId, resolveControlStop);
    if (longForm) {
      this.#activeLongEngine = "premium";
      this.#activePremiumUtteranceId = utteranceId;
    }

    let firstHeard = false;
    try {
      const firstOutcome = await Promise.race([
        firstAudio.then(() => "audio" as const),
        timedOut,
        premium.then(() => "complete" as const),
        premium.catch(() => "failed" as const),
        controlStop,
      ]);
      if (generation !== this.#generation) return;
      if (firstOutcome === "controlled") return;

      if (firstOutcome === "audio") {
        firstHeard = true;
        const completion = await Promise.race([
          premium.then(() => "complete" as const),
          controlStop,
        ]);
        if (generation !== this.#generation) return;
        if (completion === "controlled") return;
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
      await this.#speakSystem(text, options, longForm);
    } catch (error) {
      if (generation !== this.#generation) return;
      if (premiumOnly) throw error;
      this.#premiumFailed();
      if (!firstHeard) {
        await this.#speakSystem(text, options, longForm);
      }
    } finally {
      this.#clearTimer(timeout);
      this.#waiters.delete(utteranceId);
      this.#controlStops.delete(utteranceId);
      if (
        longForm &&
        this.#activePremiumUtteranceId === utteranceId
      ) {
        this.#activePremiumUtteranceId = undefined;
        this.#activeLongEngine = undefined;
      }
    }
  }

  async #waitUntilResumed(generation: number): Promise<void> {
    while (
      generation === this.#generation &&
      this.#playbackState === "paused"
    ) {
      await new Promise<void>((resolve) => {
        this.#resumeLong = resolve;
      });
    }
  }

  #stopActivePremium(): void {
    const utteranceId = this.#activePremiumUtteranceId;
    if (!utteranceId) return;
    this.#controlStops.get(utteranceId)?.();
    this.#waiters.get(utteranceId)?.cancel();
    void this.#request({ type: "premium-stop", utteranceId })
      .catch(() => undefined);
  }

  async #speakSystem(
    text: string,
    options: TtsSpeakOptions,
    longForm: boolean,
  ): Promise<void> {
    this.#activeLongEngine = longForm ? "system" : undefined;
    try {
      if (longForm) {
        await this.#system.speakLong(text, options);
      } else {
        await this.#system.speak(text, options);
      }
    } finally {
      if (longForm) this.#activeLongEngine = undefined;
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
