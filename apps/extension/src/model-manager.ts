import { t } from "./panel-i18n.js";
import {
  WAKE_WORD_CACHE_HASH_HEADER,
  WAKE_WORD_MODEL_ID,
} from "./wake-word-models.js";

export type ManagedModelId =
  | "moonshine-tiny"
  | "moonshine-base"
  | "parakeet-v3"
  | "kokoro"
  | "wake-word"
  | `kokoro-voice:${string}`;

export type ChromeModelId = "gemini-nano" | "summarizer";
export type ModelId = ManagedModelId | ChromeModelId;
export type ModelState = "active" | "cached" | "absent" | "downloading";

export interface ModelCacheMeasurement {
  readonly bytes: Readonly<Record<
    Exclude<ManagedModelId, `kokoro-voice:${string}`>,
    number
  >>;
  readonly voices: Readonly<Record<string, number>>;
}

export interface ModelInventoryRow {
  readonly id: ModelId;
  readonly label: string;
  readonly detail?: string;
  readonly state: ModelState;
  readonly readOnly: boolean;
  readonly bytes?: number;
  readonly canDownload: boolean;
  readonly canDelete: boolean;
}

export interface ModelInventory {
  readonly rows: readonly ModelInventoryRow[];
  readonly totalBytes: number;
}

export interface BuildModelInventoryOptions {
  readonly cache: ModelCacheMeasurement;
  readonly tinyDownloading?: boolean;
  readonly premiumSttTier: "parakeet" | "moonshine-base";
  readonly premiumSttState:
    | "not-downloaded"
    | "downloading"
    | "validating"
    | "loading"
    | "warming"
    | "ready"
    | "active"
    | "error";
  readonly premiumTtsState: "absent" | "downloading" | "ready" | "error";
  readonly premiumTtsEnabled: boolean;
  readonly premiumTtsVoice: string;
  readonly wakeWordEnabled: boolean;
  readonly wakeWordState:
    | "disarmed"
    | "arming"
    | "armed"
    | "suspended"
    | "error";
  readonly wakeWordDownloading?: boolean;
  readonly nano: ChromeAvailability;
  readonly nanoActive?: boolean;
  readonly summarizer: ChromeAvailability;
}

export type ChromeAvailability =
  | "unavailable"
  | "downloadable"
  | "downloading"
  | "available";

export function isManagedModelId(value: unknown): value is ManagedModelId {
  return value === "moonshine-tiny" ||
    value === "moonshine-base" ||
    value === "parakeet-v3" ||
    value === "kokoro" ||
    value === "wake-word" ||
    (typeof value === "string" &&
      /^kokoro-voice:[a-z]{2}_[a-z]+$/.test(value));
}

const EMPTY_BYTES: ModelCacheMeasurement["bytes"] = {
  "moonshine-tiny": 0,
  "moonshine-base": 0,
  "parakeet-v3": 0,
  kokoro: 0,
  "wake-word": 0,
};

const MODEL_REPOSITORIES = {
  "moonshine-tiny": "onnx-community/moonshine-tiny-ONNX",
  "moonshine-base": "onnx-community/moonshine-base-ONNX",
  "parakeet-v3": "efederici/parakeet-tdt-0.6b-v3-onnx-int4",
  kokoro: "onnx-community/Kokoro-82M-v1.0-ONNX",
  "wake-word": WAKE_WORD_MODEL_ID,
} as const;

interface CacheMatch {
  readonly id: Exclude<ManagedModelId, `kokoro-voice:${string}`>;
  readonly voice?: string;
}

function modelForUrl(url: string): CacheMatch | undefined {
  for (const id of [
    "moonshine-tiny",
    "moonshine-base",
    "parakeet-v3",
  ] as const) {
    if (url.includes(`/${MODEL_REPOSITORIES[id]}/resolve/`)) {
      return { id };
    }
  }

  if (!url.includes(`/${MODEL_REPOSITORIES.kokoro}/resolve/`)) {
    return url.includes(`/${MODEL_REPOSITORIES["wake-word"]}/resolve/`)
      ? { id: "wake-word" }
      : undefined;
  }
  const voice = /\/voices\/([a-z]{2}_[a-z]+)\.bin(?:[?#]|$)/.exec(url)?.[1];
  return voice
    ? { id: "kokoro", voice }
    : { id: "kokoro" };
}

async function responseBytes(response: Response): Promise<number> {
  for (const header of ["x-sotto-validated-size", "content-length"]) {
    const value = response.headers.get(header);
    if (value !== null && /^\d+$/.test(value)) return Number(value);
  }
  return (await response.clone().blob()).size;
}

function emptyMeasurement(): ModelCacheMeasurement {
  return { bytes: { ...EMPTY_BYTES }, voices: {} };
}

export class ModelCacheStore {
  readonly #cacheStorage: CacheStorage | undefined;
  #measurement: Promise<ModelCacheMeasurement> | undefined;

  constructor(cacheStorage?: CacheStorage) {
    this.#cacheStorage = cacheStorage;
  }

  measure(): Promise<ModelCacheMeasurement> {
    this.#measurement ??= this.#scan();
    return this.#measurement;
  }

  invalidate(): void {
    this.#measurement = undefined;
  }

  async delete(id: ManagedModelId): Promise<void> {
    if (id === "moonshine-tiny") {
      throw new TypeError("Moonshine tiny cannot be deleted");
    }
    const cacheStorage = this.#cacheStorage;
    if (!cacheStorage) return;
    const names = await cacheStorage.keys();
    for (const name of names) {
      const cache = await cacheStorage.open(name);
      const requests = await cache.keys();
      await Promise.all(
        requests.map(async (request) => {
          const match = modelForUrl(request.url);
          if (!match) return;
          const requestId = match.voice
            ? `kokoro-voice:${match.voice}` as const
            : match.id;
          if (requestId === id) await cache.delete(request);
        }),
      );
    }
    this.invalidate();
  }

  async #scan(): Promise<ModelCacheMeasurement> {
    const cacheStorage = this.#cacheStorage;
    if (!cacheStorage) return emptyMeasurement();
    const bytes = { ...EMPTY_BYTES };
    const voices: Record<string, number> = {};
    const names = await cacheStorage.keys();

    for (const name of names) {
      const cache = await cacheStorage.open(name);
      for (const request of await cache.keys()) {
        const match = modelForUrl(request.url);
        if (!match) continue;
        const response = await cache.match(request);
        if (!response) continue;
        if (
          match.id === "wake-word" &&
          response.headers.get(WAKE_WORD_CACHE_HASH_HEADER) === null
        ) {
          continue;
        }
        const size = await responseBytes(response).catch(() => 0);
        if (match.voice) {
          voices[match.voice] = (voices[match.voice] ?? 0) + size;
        } else {
          bytes[match.id] += size;
        }
      }
    }
    return { bytes, voices };
  }
}

export function deriveModelState(options: {
  readonly active?: boolean;
  readonly cached?: boolean;
  readonly downloading?: boolean;
}): ModelState {
  if (options.downloading) return "downloading";
  if (options.active) return "active";
  if (options.cached) return "cached";
  return "absent";
}

function managedRow(
  id: ManagedModelId,
  label: string,
  bytes: number,
  state: ModelState,
  detail?: string,
): ModelInventoryRow {
  return {
    id,
    label,
    ...(detail === undefined ? {} : { detail }),
    state,
    readOnly: false,
    bytes,
    canDownload: state === "absent" && !id.startsWith("kokoro-voice:"),
    canDelete: id !== "moonshine-tiny" &&
      (state === "active" || state === "cached"),
  };
}

function chromeState(
  availability: ChromeAvailability,
  active: boolean,
): ModelState {
  return deriveModelState({
    active,
    cached: availability === "available",
    downloading: availability === "downloading",
  });
}

function chromeRow(
  id: ChromeModelId,
  label: string,
  availability: ChromeAvailability,
  active = false,
): ModelInventoryRow {
  return {
    id,
    label,
    detail: t("modelChromeManaged"),
    state: chromeState(availability, active),
    readOnly: true,
    canDownload: false,
    canDelete: false,
  };
}

export function totalModelBytes(
  rows: readonly ModelInventoryRow[],
): number {
  return rows.reduce((total, row) => total + (row.bytes ?? 0), 0);
}

export function buildModelInventory(
  options: BuildModelInventoryOptions,
): ModelInventory {
  const sttBusy = options.premiumSttState === "downloading" ||
    options.premiumSttState === "validating" ||
    options.premiumSttState === "loading" ||
    options.premiumSttState === "warming";
  const premiumSttId = options.premiumSttTier === "parakeet"
    ? "parakeet-v3" as const
    : "moonshine-base" as const;
  const tinyBytes = options.cache.bytes["moonshine-tiny"];
  const tinyState = deriveModelState({
    active: tinyBytes > 0 && options.premiumSttState !== "active",
    cached: tinyBytes > 0,
    ...(options.tinyDownloading === undefined
      ? {}
      : { downloading: options.tinyDownloading }),
  });
  const rows: ModelInventoryRow[] = [
    managedRow(
      "moonshine-tiny",
      t("modelMoonshineTiny"),
      tinyBytes,
      tinyState,
      t("modelDefaultSpeechInput"),
    ),
  ];

  for (const id of ["moonshine-base", "parakeet-v3"] as const) {
    const bytes = options.cache.bytes[id];
    if (id !== premiumSttId && bytes === 0) continue;
    rows.push(
      managedRow(
        id,
        id === "parakeet-v3"
          ? t("modelParakeetV3")
          : t("modelMoonshineBase"),
        bytes,
        deriveModelState({
          active: id === premiumSttId &&
            options.premiumSttState === "active",
          cached: bytes > 0,
          downloading: id === premiumSttId && sttBusy,
        }),
        id === "parakeet-v3"
          ? t("modelHighAccuracyInput")
          : t("modelSpeechInputUpgrade"),
      ),
    );
  }

  const kokoroBytes = options.cache.bytes.kokoro;
  const kokoroActive = options.premiumTtsState === "ready" &&
    options.premiumTtsEnabled;
  rows.push(
    managedRow(
      "kokoro",
      t("modelKokoro"),
      kokoroBytes,
      deriveModelState({
        active: kokoroActive,
        cached: kokoroBytes > 0,
        downloading: options.premiumTtsState === "downloading",
      }),
      t("modelPremiumSpeechOutput"),
    ),
  );

  for (const [voice, bytes] of Object.entries(options.cache.voices).sort()) {
    const voiceName = voice.split("_").at(-1) ?? voice;
    rows.push(
      managedRow(
        `kokoro-voice:${voice}`,
        t(
          "modelKokoroVoice",
          voiceName.charAt(0).toUpperCase() + voiceName.slice(1),
        ),
        bytes,
        deriveModelState({
          active: kokoroActive && voice === options.premiumTtsVoice,
          cached: bytes > 0,
        }),
      ),
    );
  }

  const wakeBytes = options.cache.bytes["wake-word"];
  rows.push(
    managedRow(
      "wake-word",
      t("modelWakePhrase"),
      wakeBytes,
      deriveModelState({
        active: options.wakeWordEnabled &&
          (
            options.wakeWordState === "armed" ||
            options.wakeWordState === "suspended"
        ),
        cached: wakeBytes > 0,
        ...(options.wakeWordDownloading === undefined
          ? {}
          : { downloading: options.wakeWordDownloading }),
      }),
      t("modelWakePhraseDetail"),
    ),
  );

  rows.push(
    chromeRow(
      "gemini-nano",
      t("geminiNano"),
      options.nano,
      options.nanoActive,
    ),
    chromeRow("summarizer", t("modelSummarizer"), options.summarizer),
  );
  return { rows, totalBytes: totalModelBytes(rows) };
}

export async function deleteManagedModel(options: {
  readonly id: ManagedModelId;
  readonly active: boolean;
  readonly fallback: () => Promise<void>;
  readonly release: () => Promise<boolean>;
  readonly clear: () => Promise<void>;
}): Promise<void> {
  if (options.id === "moonshine-tiny") {
    throw new TypeError("Moonshine tiny cannot be deleted");
  }
  if (options.active) await options.fallback();
  if (!(await options.release())) {
    throw new Error("The model is still in use");
  }
  await options.clear();
}
