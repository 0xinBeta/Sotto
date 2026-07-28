import type {
  LongFormTtsEngine,
  TtsLongSpeakOptions,
  TtsSpeakOptions,
} from "@sotto/tts";

export const SPEECH_RATE_KEY = "speechRate";
export const SPEECH_VOLUME_KEY = "speechVolume";
export const MIN_SPEECH_RATE = 0.5;
export const MAX_SPEECH_RATE = 2;
export const MIN_SPEECH_VOLUME = 0;
export const MAX_SPEECH_VOLUME = 1;

export interface SpeechSettings {
  readonly rate: number;
  readonly volume: number;
}

export const DEFAULT_SPEECH_SETTINGS: SpeechSettings = {
  rate: 1,
  volume: 1,
};

export interface SpeechSettingsStorage {
  get(keys: readonly string[]): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
}

export function clampSpeechRate(rate: number): number {
  return Math.max(MIN_SPEECH_RATE, Math.min(MAX_SPEECH_RATE, rate));
}

export function clampSpeechVolume(volume: number): number {
  return Math.max(MIN_SPEECH_VOLUME, Math.min(MAX_SPEECH_VOLUME, volume));
}

export function normalizeSpeechSettings(
  stored: Record<string, unknown>,
): SpeechSettings {
  const storedRate = stored[SPEECH_RATE_KEY];
  const storedVolume = stored[SPEECH_VOLUME_KEY];
  return {
    rate:
      typeof storedRate === "number" && Number.isFinite(storedRate)
        ? clampSpeechRate(storedRate)
        : DEFAULT_SPEECH_SETTINGS.rate,
    volume:
      typeof storedVolume === "number" && Number.isFinite(storedVolume)
        ? clampSpeechVolume(storedVolume)
        : DEFAULT_SPEECH_SETTINGS.volume,
  };
}

export class SpeechSettingsStore {
  readonly #storage: SpeechSettingsStorage;
  #settings = DEFAULT_SPEECH_SETTINGS;
  #ready: Promise<void> | undefined;
  #updateTail: Promise<unknown> = Promise.resolve();

  constructor(storage: SpeechSettingsStorage) {
    this.#storage = storage;
  }

  async get(): Promise<SpeechSettings> {
    await this.#ensureReady();
    await this.#updateTail.catch(() => undefined);
    return { ...this.#settings };
  }

  update(
    update: Partial<SpeechSettings>,
  ): Promise<SpeechSettings> {
    const pending = this.#updateTail
      .catch(() => undefined)
      .then(async () => {
        await this.#ensureReady();
        const next = {
          rate:
            update.rate === undefined
              ? this.#settings.rate
              : clampSpeechRate(update.rate),
          volume:
            update.volume === undefined
              ? this.#settings.volume
              : clampSpeechVolume(update.volume),
        };
        this.#settings = next;
        await this.#storage.set({
          [SPEECH_RATE_KEY]: next.rate,
          [SPEECH_VOLUME_KEY]: next.volume,
        });
        return { ...next };
      });
    this.#updateTail = pending;
    return pending;
  }

  async #ensureReady(): Promise<void> {
    this.#ready ??= this.#load();
    await this.#ready;
  }

  async #load(): Promise<void> {
    try {
      this.#settings = normalizeSpeechSettings(
        await this.#storage.get([
          SPEECH_RATE_KEY,
          SPEECH_VOLUME_KEY,
        ]),
      );
    } catch (error) {
      this.#settings = DEFAULT_SPEECH_SETTINGS;
      console.warn(
        "Unable to read speech settings; using defaults",
        error,
      );
    }
  }
}

export class SpeechSettingsTtsEngine implements LongFormTtsEngine {
  readonly #engine: LongFormTtsEngine;
  readonly #settings: SpeechSettingsStore;
  #generation = 0;

  constructor(
    engine: LongFormTtsEngine,
    settings: SpeechSettingsStore,
  ) {
    this.#engine = engine;
    this.#settings = settings;
  }

  async speak(
    text: string,
    options: TtsSpeakOptions = {},
  ): Promise<void> {
    const generation = this.#generation;
    const settings = await this.#settings.get();
    if (generation !== this.#generation) return;
    await this.#engine.speak(text, { ...options, ...settings });
  }

  async speakLong(
    text: string,
    options: TtsLongSpeakOptions = {},
  ): Promise<void> {
    const generation = this.#generation;
    const settings = await this.#settings.get();
    if (generation !== this.#generation) return;
    await this.#engine.speakLong(text, { ...options, ...settings });
  }

  stop(): void {
    this.#generation += 1;
    this.#engine.stop();
  }
}
