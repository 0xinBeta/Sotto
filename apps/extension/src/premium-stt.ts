import type {
  SttEngine,
  SttProgress,
} from "@sotto/stt";

import {
  isPlausibleSttText,
  isWebGpuSttFailure,
  type SttDiagnostic,
} from "./stt-guards.js";

export const PREMIUM_STT_ENABLED_KEY = "premiumSttEnabled";
export const PREMIUM_STT_DOWNLOADED_KEY = "premiumSttDownloaded";
export const PREMIUM_STT_DOWNLOADED_TIERS_KEY = "premiumSttDownloadedTiers";
export const PREMIUM_STT_TIER_KEY = "premiumSttTier";
export const PREMIUM_STT_WARMUP_MAX_MS = 1_200;

export type PremiumSttTier = "parakeet" | "moonshine-base";
export type PremiumSttState =
  | "not-downloaded"
  | "downloading"
  | "validating"
  | "loading"
  | "warming"
  | "ready"
  | "active"
  | "error";

export interface PremiumSttStatus {
  readonly state: PremiumSttState;
  readonly enabled: boolean;
  readonly downloaded: boolean;
  readonly resident: boolean;
  readonly resumable: boolean;
  readonly tier: PremiumSttTier;
  readonly backend: "webgpu" | "wasm";
  readonly error?: string;
}

export interface PremiumSttManagerOptions {
  readonly tiny: SttEngine;
  readonly tier: PremiumSttTier;
  readonly downloaded?: boolean;
  readonly storedEnabled?: unknown;
  readonly createPremium: (tier: PremiumSttTier) => SttEngine;
  readonly runInference: <T>(task: () => Promise<T>) => Promise<T>;
  readonly runTranscription?: <T>(task: () => Promise<T>) => Promise<T>;
  readonly selfTestAudio: () => Promise<Float32Array>;
  readonly onStatus?: (status: PremiumSttStatus) => void;
  readonly onProgress?: (progress: SttProgress) => void;
  readonly onTinyProgress?: (progress: SttProgress) => void;
  readonly onDiagnostic?: (diagnostic: SttDiagnostic) => void;
  readonly onMemoryPressure?: () => Promise<void>;
  readonly onResidentChange?: (resident: boolean) => void;
  readonly now?: () => number;
  readonly warmupMaxMs?: number;
}

export function premiumSttEnabledByDefault(
  storedEnabled: unknown,
  downloaded: boolean,
): boolean {
  return typeof storedEnabled === "boolean"
    ? storedEnabled
    : downloaded;
}

interface WebGpuProvider {
  requestAdapter(): Promise<unknown | null>;
}

export async function detectPremiumSttTier(): Promise<PremiumSttTier> {
  const gpu = (navigator as Navigator & { gpu?: WebGpuProvider }).gpu;
  if (!gpu) return "moonshine-base";
  const adapter = await gpu.requestAdapter().catch(() => null);
  return adapter ? "parakeet" : "moonshine-base";
}

function diagnosticFor(error: unknown): SttDiagnostic | undefined {
  if (isWebGpuSttFailure(error)) return "webgpu-failed";
  if (
    error instanceof DOMException &&
    error.name === "TimeoutError"
  ) {
    return "timeout";
  }
  if (
    error instanceof Error &&
    /self-test.*(?:blank|plausible)/i.test(error.message)
  ) {
    return "blank-result";
  }
  return undefined;
}

async function withDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new DOMException(
            "Premium STT self-test exceeded the latency threshold",
            "TimeoutError",
          ),
        ),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export class PremiumSttManager {
  readonly #tiny: SttEngine;
  readonly #tier: PremiumSttTier;
  readonly #createPremium: (tier: PremiumSttTier) => SttEngine;
  readonly #runInference: <T>(task: () => Promise<T>) => Promise<T>;
  readonly #runTranscription: <T>(task: () => Promise<T>) => Promise<T>;
  readonly #selfTestAudio: () => Promise<Float32Array>;
  readonly #onStatus: (status: PremiumSttStatus) => void;
  readonly #onProgress: (progress: SttProgress) => void;
  readonly #onTinyProgress: (progress: SttProgress) => void;
  readonly #onDiagnostic: (diagnostic: SttDiagnostic) => void;
  readonly #onMemoryPressure: () => Promise<void>;
  readonly #onResidentChange: (resident: boolean) => void;
  readonly #now: () => number;
  readonly #warmupMaxMs: number;

  #state: PremiumSttState;
  #enabled: boolean;
  #hasStoredEnabled: boolean;
  #downloaded: boolean;
  #resumable = false;
  #error: string | undefined;
  #premium: SttEngine | undefined;
  #tinyReady = false;
  #tinyTransition: Promise<void> | undefined;
  #pending: Promise<void> | undefined;
  #settingGeneration = 0;

  constructor(options: PremiumSttManagerOptions) {
    this.#tiny = options.tiny;
    this.#tier = options.tier;
    this.#createPremium = options.createPremium;
    this.#runInference = options.runInference;
    this.#runTranscription =
      options.runTranscription ?? options.runInference;
    this.#selfTestAudio = options.selfTestAudio;
    this.#onStatus = options.onStatus ?? (() => undefined);
    this.#onProgress = options.onProgress ?? (() => undefined);
    this.#onTinyProgress = options.onTinyProgress ?? (() => undefined);
    this.#onDiagnostic = options.onDiagnostic ?? (() => undefined);
    this.#onMemoryPressure = options.onMemoryPressure ??
      (() => Promise.resolve());
    this.#onResidentChange = options.onResidentChange ?? (() => undefined);
    this.#now = options.now ?? performance.now.bind(performance);
    this.#warmupMaxMs =
      options.warmupMaxMs ?? PREMIUM_STT_WARMUP_MAX_MS;
    this.#downloaded = options.downloaded === true;
    this.#hasStoredEnabled = typeof options.storedEnabled === "boolean";
    this.#enabled = premiumSttEnabledByDefault(
      options.storedEnabled,
      this.#downloaded,
    );
    this.#state = this.#downloaded ? "ready" : "not-downloaded";
  }

  get status(): PremiumSttStatus {
    return {
      state: this.#state,
      enabled: this.#enabled,
      downloaded: this.#downloaded,
      resident: this.#premium !== undefined,
      resumable: this.#resumable,
      tier: this.#tier,
      backend: this.#tier === "parakeet" ? "webgpu" : "wasm",
      ...(this.#error === undefined ? {} : { error: this.#error }),
    };
  }

  async initializeDefault(): Promise<void> {
    await this.#ensureTiny();
    this.#emitStatus();
    if (this.#downloaded && this.#enabled) {
      void this.prepare().catch(() => undefined);
    }
  }

  async prepare(): Promise<void> {
    if (this.#pending) return this.#pending;
    const pending = (async () => {
      await this.#ensureTiny();
      await this.#prepareWithAllocationRetry(!this.#downloaded);
    })();
    this.#pending = pending;
    try {
      await pending;
    } finally {
      if (this.#pending === pending) this.#pending = undefined;
    }
  }

  async setEnabled(enabled: boolean): Promise<void> {
    const settingGeneration = ++this.#settingGeneration;
    this.#enabled = enabled;
    this.#hasStoredEnabled = true;
    this.#error = undefined;
    if (!this.#downloaded) {
      this.#state = "not-downloaded";
      this.#emitStatus();
      return;
    }
    if (enabled) {
      if (!this.#premium) await this.prepare();
      if (
        settingGeneration === this.#settingGeneration &&
        this.#enabled &&
        this.#premium
      ) {
        this.#state = "active";
        await this.#disposeTinyIfActive(settingGeneration);
      }
    } else {
      await this.#ensureTiny();
      if (
        settingGeneration === this.#settingGeneration &&
        !this.#enabled
      ) {
        this.#state = "ready";
      }
    }
    this.#emitStatus();
  }

  async transcribe(audio: Float32Array): Promise<string> {
    const premium = this.#premium;
    if (!premium || !this.#enabled || this.#state !== "active") {
      await this.#ensureTiny();
      const result = await this.#runTranscription(() =>
        this.#tiny.transcribe(audio)
      );
      if (
        this.#downloaded &&
        this.#enabled &&
        !this.#premium &&
        this.#state !== "error"
      ) {
        void this.prepare().catch(() => undefined);
      }
      return result;
    }

    try {
      return await this.#runTranscription(() => premium.transcribe(audio));
    } catch (error) {
      if (this.#tier !== "parakeet" || !isWebGpuSttFailure(error)) {
        throw error;
      }
      this.#onDiagnostic("webgpu-failed");
      await this.#onMemoryPressure();
      await this.releasePremium().catch(() => undefined);
      try {
        await this.#loadPremium(false);
        const replacement = this.#premium;
        if (!replacement) {
          throw new Error("Premium STT reload did not produce a resident model");
        }
        return await this.#runTranscription(() =>
          replacement.transcribe(audio)
        );
      } catch (retryError) {
        if (this.status.state !== "error") {
          await this.#fallbackToTiny(retryError);
        } else {
          await this.#ensureTiny();
        }
        return this.#runTranscription(() => this.#tiny.transcribe(audio));
      }
    }
  }

  async releasePremium(): Promise<void> {
    const engine = this.#premium;
    if (!engine) return;
    this.#premium = undefined;
    this.#onResidentChange(false);
    await this.#runInference(() => engine.dispose());
    this.#emitStatus();
  }

  async markDeleted(): Promise<void> {
    await this.releasePremium();
    this.#settingGeneration += 1;
    this.#downloaded = false;
    this.#enabled = false;
    this.#resumable = false;
    this.#error = undefined;
    this.#state = "not-downloaded";
    this.#emitStatus();
  }

  async dispose(): Promise<void> {
    const pending = this.#pending;
    this.#pending = undefined;
    await pending?.catch(() => undefined);
    await this.releasePremium();
    await this.#tinyTransition?.catch(() => undefined);
    if (this.#tinyReady) {
      await this.#runInference(() => this.#tiny.dispose());
      this.#tinyReady = false;
    }
  }

  async #prepareWithAllocationRetry(
    downloadExpected: boolean,
  ): Promise<void> {
    try {
      await this.#loadPremium(downloadExpected);
    } catch (error) {
      if (this.#tier !== "parakeet" || !isWebGpuSttFailure(error)) {
        throw error;
      }
      await this.#onMemoryPressure();
      await this.#loadPremium(false);
    }
  }

  async #loadPremium(downloadExpected: boolean): Promise<void> {
    const candidate = this.#createPremium(this.#tier);
    this.#error = undefined;
    this.#setState(downloadExpected ? "downloading" : "loading");

    try {
      await candidate.init((progress) => {
        if (typeof progress.resumable === "boolean") {
          this.#resumable = progress.resumable;
        }
        if (progress.status === "downloading") {
          this.#setState("downloading");
        } else if (progress.status === "validating") {
          this.#setState("validating");
        } else if (progress.status === "loading") {
          this.#setState("loading");
        }
        this.#onProgress(progress);
      });
      if (
        this.#state === "downloading" ||
        this.#state === "loading"
      ) {
        this.#setState("validating");
      }
      this.#setState("loading");
      this.#setState("warming");
      const fixture = await this.#selfTestAudio();
      const startedAt = this.#now();
      const text = await withDeadline(
        this.#runInference(() => candidate.transcribe(fixture)),
        this.#warmupMaxMs,
      );
      const elapsed = this.#now() - startedAt;
      if (elapsed > this.#warmupMaxMs) {
        throw new DOMException(
          "Premium STT self-test exceeded the latency threshold",
          "TimeoutError",
        );
      }
      if (!isPlausibleSttText(text, fixture.length)) {
        throw new Error(
          "Premium STT self-test returned blank or implausible text",
        );
      }

      const previous = this.#premium;
      this.#premium = candidate;
      this.#downloaded = true;
      this.#resumable = false;
      this.#onResidentChange(true);
      this.#setState("ready");
      if (!this.#hasStoredEnabled) this.#enabled = true;
      if (this.#enabled) {
        this.#setState("active");
        await this.#disposeTinyIfActive(this.#settingGeneration);
      }
      if (previous && previous !== candidate) {
        await this.#runInference(() => previous.dispose());
      }
    } catch (error) {
      const timedOut = error instanceof DOMException &&
        error.name === "TimeoutError";
      if (timedOut) {
        void this.#runInference(() => candidate.dispose()).catch(() => undefined);
      } else {
        await this.#runInference(() => candidate.dispose()).catch(() => undefined);
      }
      await this.#fallbackToTiny(error);
      throw error;
    }
  }

  async #fallbackToTiny(error: unknown): Promise<void> {
    if (this.#premium) {
      const engine = this.#premium;
      this.#premium = undefined;
      this.#onResidentChange(false);
      await this.#runInference(() => engine.dispose()).catch(() => undefined);
    }
    await this.#ensureTiny();
    this.#error =
      error instanceof Error ? error.message : "Premium STT setup failed";
    this.#state = "error";
    const diagnostic = diagnosticFor(error);
    if (diagnostic) this.#onDiagnostic(diagnostic);
    this.#emitStatus();
  }

  async #ensureTiny(): Promise<void> {
    if (this.#tinyTransition) {
      await this.#tinyTransition.catch(() => undefined);
      return this.#ensureTiny();
    }
    if (this.#tinyReady) return;
    const pending = this.#runInference(() =>
      this.#tiny.init(this.#onTinyProgress)
    ).then(() => {
      this.#tinyReady = true;
    });
    this.#tinyTransition = pending;
    try {
      await pending;
    } finally {
      if (this.#tinyTransition === pending) this.#tinyTransition = undefined;
    }
  }

  async #disposeTinyIfActive(settingGeneration: number): Promise<void> {
    if (this.#tinyTransition) {
      await this.#tinyTransition.catch(() => undefined);
      return this.#disposeTinyIfActive(settingGeneration);
    }
    if (!this.#enabled || settingGeneration !== this.#settingGeneration) return;
    if (!this.#tinyReady) return;
    const pending = this.#runInference(() => this.#tiny.dispose()).then(() => {
      this.#tinyReady = false;
    });
    this.#tinyTransition = pending;
    try {
      await pending;
    } finally {
      if (this.#tinyTransition === pending) this.#tinyTransition = undefined;
    }
    if (!this.#enabled || settingGeneration !== this.#settingGeneration) {
      await this.#ensureTiny();
    }
  }

  #setState(state: PremiumSttState): void {
    this.#state = state;
    this.#emitStatus();
  }

  #emitStatus(): void {
    this.#onStatus(this.status);
  }
}
