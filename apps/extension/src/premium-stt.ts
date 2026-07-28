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
  #error: string | undefined;
  #premium: SttEngine | undefined;
  #tinyReady = false;
  #pending: Promise<void> | undefined;

  constructor(options: PremiumSttManagerOptions) {
    this.#tiny = options.tiny;
    this.#tier = options.tier;
    this.#createPremium = options.createPremium;
    this.#runInference = options.runInference;
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
      tier: this.#tier,
      backend: this.#tier === "parakeet" ? "webgpu" : "wasm",
      ...(this.#error === undefined ? {} : { error: this.#error }),
    };
  }

  async initializeDefault(): Promise<void> {
    if (this.#downloaded && this.#enabled) {
      await this.#loadPremium(false).catch(() => undefined);
      return;
    }
    await this.#ensureTiny();
    this.#emitStatus();
  }

  async prepare(): Promise<void> {
    if (this.#pending) return this.#pending;
    const pending = this.#prepareWithAllocationRetry(!this.#downloaded);
    this.#pending = pending;
    try {
      await pending;
    } finally {
      if (this.#pending === pending) this.#pending = undefined;
    }
  }

  async setEnabled(enabled: boolean): Promise<void> {
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
      if (this.#premium) {
        this.#state = "active";
        await this.#disposeTiny();
      }
    } else {
      await this.#ensureTiny();
      this.#state = "ready";
    }
    this.#emitStatus();
  }

  async transcribe(audio: Float32Array): Promise<string> {
    if (
      this.#downloaded &&
      this.#enabled &&
      !this.#premium &&
      this.#state !== "error"
    ) {
      await this.prepare().catch(() => undefined);
    }
    if (!this.#premium || !this.#enabled || this.#state !== "active") {
      await this.#ensureTiny();
      return this.#runInference(() => this.#tiny.transcribe(audio));
    }

    try {
      return await this.#runInference(() => this.#premium!.transcribe(audio));
    } catch (error) {
      if (this.#tier !== "parakeet" || !isWebGpuSttFailure(error)) {
        throw error;
      }
      this.#onDiagnostic("webgpu-failed");
      await this.#onMemoryPressure();
      await this.releasePremium();
      try {
        await this.#loadPremium(false);
        return await this.#runInference(() => this.#premium!.transcribe(audio));
      } catch (retryError) {
        await this.#fallbackToTiny(retryError);
        return this.#runInference(() => this.#tiny.transcribe(audio));
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

  async dispose(): Promise<void> {
    const pending = this.#pending;
    this.#pending = undefined;
    await pending?.catch(() => undefined);
    await this.releasePremium();
    await this.#runInference(() => this.#tiny.dispose());
    this.#tinyReady = false;
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
      this.#onResidentChange(true);
      this.#setState("ready");
      if (!this.#hasStoredEnabled) this.#enabled = true;
      if (this.#enabled) {
        this.#setState("active");
        await this.#disposeTiny();
      }
      if (previous && previous !== candidate) {
        await this.#runInference(() => previous.dispose());
      }
    } catch (error) {
      await this.#runInference(() => candidate.dispose()).catch(() => undefined);
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
    if (this.#tinyReady) return;
    await this.#runInference(() => this.#tiny.init(this.#onTinyProgress));
    this.#tinyReady = true;
  }

  async #disposeTiny(): Promise<void> {
    if (!this.#tinyReady) return;
    await this.#runInference(() => this.#tiny.dispose());
    this.#tinyReady = false;
  }

  #setState(state: PremiumSttState): void {
    this.#state = state;
    this.#emitStatus();
  }

  #emitStatus(): void {
    this.#onStatus(this.status);
  }
}
