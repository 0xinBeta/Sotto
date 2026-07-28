import { KokoroTTS, TextSplitterStream, env } from "kokoro-js";

import { normalizeTtsText } from "./chunker.js";
import type {
  LongFormTtsEngine,
  TtsLongSpeakOptions,
  TtsProgress,
  TtsSpeakOptions,
} from "./types.js";

export const KOKORO_MODEL_ID =
  "onnx-community/Kokoro-82M-v1.0-ONNX";
export const KOKORO_MODEL_REVISION =
  "1939ad2a8e416c0acfeecc08a694d14ef25f2231";
export const KOKORO_VOICES = [
  { id: "af_heart", label: "Heart", accent: "US" },
  { id: "af_alloy", label: "Alloy", accent: "US" },
  { id: "af_aoede", label: "Aoede", accent: "US" },
  { id: "af_bella", label: "Bella", accent: "US" },
  { id: "af_jessica", label: "Jessica", accent: "US" },
  { id: "af_kore", label: "Kore", accent: "US" },
  { id: "af_nicole", label: "Nicole", accent: "US" },
  { id: "af_nova", label: "Nova", accent: "US" },
  { id: "af_river", label: "River", accent: "US" },
  { id: "af_sarah", label: "Sarah", accent: "US" },
  { id: "af_sky", label: "Sky", accent: "US" },
  { id: "am_adam", label: "Adam", accent: "US" },
  { id: "am_echo", label: "Echo", accent: "US" },
  { id: "am_eric", label: "Eric", accent: "US" },
  { id: "am_fenrir", label: "Fenrir", accent: "US" },
  { id: "am_liam", label: "Liam", accent: "US" },
  { id: "am_michael", label: "Michael", accent: "US" },
  { id: "am_onyx", label: "Onyx", accent: "US" },
  { id: "am_puck", label: "Puck", accent: "US" },
  { id: "am_santa", label: "Santa", accent: "US" },
  { id: "bf_emma", label: "Emma", accent: "GB" },
  { id: "bf_isabella", label: "Isabella", accent: "GB" },
  { id: "bm_george", label: "George", accent: "GB" },
  { id: "bm_lewis", label: "Lewis", accent: "GB" },
  { id: "bf_alice", label: "Alice", accent: "GB" },
  { id: "bf_lily", label: "Lily", accent: "GB" },
  { id: "bm_daniel", label: "Daniel", accent: "GB" },
  { id: "bm_fable", label: "Fable", accent: "GB" },
] as const;
export type KokoroVoice = (typeof KOKORO_VOICES)[number];
export type KokoroVoiceId = KokoroVoice["id"];
export const KOKORO_VOICE: KokoroVoiceId = "af_heart";
export const KOKORO_SAMPLE_RATE = 24_000;
export const MAX_KOKORO_CHUNK_CHARACTERS = 200;
export const KOKORO_WASM_ASSET_PATH = "assets/ort-kokoro/";

const MAX_AUDIO_LOOKAHEAD = 3;
const PREWARM_TEXT = "Ready.";

export type KokoroBackend = "webgpu" | "wasm";
export type KokoroDtype = "fp32" | "q8";

export interface KokoroInitProgress {
  readonly status: string;
  readonly file?: string;
  readonly loaded?: number;
  readonly total?: number;
  readonly progress?: number;
}

export type KokoroProgressCallback = (progress: KokoroInitProgress) => void;

export interface KokoroSpeakOptions extends TtsSpeakOptions {
  readonly voice?: KokoroVoiceId;
}

export interface KokoroLongSpeakOptions extends TtsLongSpeakOptions {
  readonly voice?: KokoroVoiceId;
}

export interface KokoroPrewarmOptions {
  readonly signal?: AbortSignal;
}

interface RawKokoroAudio {
  readonly data: Float32Array;
  readonly sampling_rate: number;
}

interface KokoroModel {
  readonly model: {
    dispose(): void | Promise<void>;
  };
  generate(
    text: string,
    options: {
      readonly voice: typeof KOKORO_VOICE;
      readonly speed: number;
    },
  ): Promise<RawKokoroAudio>;
}

interface Splitter {
  push(...text: string[]): void;
  close(): void;
  [Symbol.iterator](): Iterator<string>;
}

export interface KokoroRuntime {
  load(options: {
    readonly modelId: string;
    readonly revision: string;
    readonly device: KokoroBackend;
    readonly dtype: KokoroDtype;
    readonly onProgress: (progress: KokoroInitProgress) => void;
  }): Promise<KokoroModel>;
  createSplitter(): Splitter;
  setWasmPaths(path: string): void;
}

export interface KokoroTtsEngineOptions {
  readonly runtime?: KokoroRuntime;
  readonly audioContextFactory?: () => AudioContext;
  readonly backend?: KokoroBackend | "auto";
  readonly runtimeUrl?: (path: string) => string;
  readonly runInference?: <T>(
    task: () => Promise<T>,
    signal?: AbortSignal,
  ) => Promise<T>;
  readonly runWarmupInference?: <T>(
    task: () => Promise<T>,
    signal?: AbortSignal,
  ) => Promise<T>;
  readonly webGpuAvailable?: () => Promise<boolean>;
  readonly voice?: KokoroVoiceId;
}

interface ScheduledAudio {
  readonly source: AudioBufferSourceNode;
  readonly done: Promise<void>;
  finish(): void;
}

interface ActiveOperation {
  readonly generation: number;
  readonly controller: AbortController;
  splitter: Splitter | undefined;
}

const defaultRuntime: KokoroRuntime = {
  async load(options) {
    return await KokoroTTS.from_pretrained(options.modelId, {
      revision: options.revision,
      device: options.device,
      dtype: options.dtype,
      progress_callback: (progress) => {
        options.onProgress(progress as KokoroInitProgress);
      },
    }) as unknown as KokoroModel;
  },
  createSplitter() {
    return new TextSplitterStream();
  },
  setWasmPaths(path) {
    env.wasmPaths = path;
  },
};

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

export function isKokoroVoiceId(value: unknown): value is KokoroVoiceId {
  return (
    typeof value === "string" &&
    KOKORO_VOICES.some((voice) => voice.id === value)
  );
}

function splitHardCapped(text: string): string[] {
  const chunks: string[] = [];
  let remaining = text.trim();

  while (remaining.length > MAX_KOKORO_CHUNK_CHARACTERS) {
    const maximum = safeUtf16End(
      remaining,
      MAX_KOKORO_CHUNK_CHARACTERS,
    );
    const candidate = remaining.slice(0, maximum);
    const punctuation = Math.max(
      candidate.lastIndexOf(". "),
      candidate.lastIndexOf("! "),
      candidate.lastIndexOf("? "),
      candidate.lastIndexOf("; "),
      candidate.lastIndexOf(", "),
    );
    const whitespace = candidate.lastIndexOf(" ");
    const boundary = punctuation >= Math.floor(maximum * 0.55)
      ? punctuation + 1
      : whitespace >= Math.floor(maximum * 0.55)
        ? whitespace
        : maximum;
    const chunk = remaining.slice(0, boundary).trim();
    if (chunk) chunks.push(chunk);
    remaining = remaining.slice(boundary).trim();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

export function splitTextForKokoro(
  text: string,
  createSplitter: () => Splitter = () => new TextSplitterStream(),
): string[] {
  const normalized = normalizeTtsText(text);
  if (!normalized) return [];

  const splitter = createSplitter();
  splitter.push(normalized);
  splitter.close();

  const chunks: string[] = [];
  for (const sentence of splitter) {
    chunks.push(
      ...splitHardCapped(sentence).filter((chunk) =>
        /[\p{L}\p{N}]/u.test(chunk)
      ),
    );
  }
  return chunks;
}

export async function selectKokoroBackend(
  canUseWebGpu: () => Promise<boolean> = async () => {
    if (!("navigator" in globalThis)) return false;
    const gpu = (
      globalThis.navigator as Navigator & {
        gpu?: {
          requestAdapter(): Promise<unknown | null>;
        };
      }
    ).gpu;
    return gpu
      ? (await gpu.requestAdapter().catch(() => null)) !== null
      : false;
  },
): Promise<{ readonly backend: KokoroBackend; readonly dtype: KokoroDtype }> {
  return await canUseWebGpu()
    ? { backend: "webgpu", dtype: "fp32" }
    : { backend: "wasm", dtype: "q8" };
}

function abortError(): DOMException {
  return new DOMException("Kokoro speech was cancelled", "AbortError");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

async function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  throwIfAborted(signal);
  return await Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(abortError()), {
        once: true,
      });
    }),
  ]);
}

export class KokoroTtsEngine implements LongFormTtsEngine {
  readonly #runtime: KokoroRuntime;
  readonly #audioContextFactory: () => AudioContext;
  readonly #backendPreference: KokoroBackend | "auto";
  readonly #runtimeUrl: (path: string) => string;
  readonly #runInference: <T>(
    task: () => Promise<T>,
    signal?: AbortSignal,
  ) => Promise<T>;
  readonly #runWarmupInference: <T>(
    task: () => Promise<T>,
    signal?: AbortSignal,
  ) => Promise<T>;
  readonly #webGpuAvailable: (() => Promise<boolean>) | undefined;

  #tts: KokoroModel | undefined;
  #initPromise: Promise<void> | undefined;
  #audioContext: AudioContext | undefined;
  #activeOperation: ActiveOperation | undefined;
  #sources = new Set<ScheduledAudio>();
  #nextStartTime = 0;
  #generation = 0;
  #inferenceTail: Promise<unknown> = Promise.resolve();
  #backend: KokoroBackend | undefined;
  #dtype: KokoroDtype | undefined;
  #voice: KokoroVoiceId;

  constructor(options: KokoroTtsEngineOptions = {}) {
    this.#runtime = options.runtime ?? defaultRuntime;
    this.#audioContextFactory =
      options.audioContextFactory ?? (() => new AudioContext());
    this.#backendPreference = options.backend ?? "auto";
    this.#runtimeUrl =
      options.runtimeUrl ??
      ((path) => chrome.runtime.getURL(path));
    this.#runInference =
      options.runInference ??
      (async <T>(task: () => Promise<T>) => await task());
    this.#runWarmupInference =
      options.runWarmupInference ?? this.#runInference;
    this.#webGpuAvailable = options.webGpuAvailable;
    this.#voice = options.voice ?? KOKORO_VOICE;
  }

  get backend(): KokoroBackend | undefined {
    return this.#backend;
  }

  get dtype(): KokoroDtype | undefined {
    return this.#dtype;
  }

  get voice(): KokoroVoiceId {
    return this.#voice;
  }

  setVoice(voice: KokoroVoiceId): void {
    this.#voice = voice;
  }

  async init(onProgress?: KokoroProgressCallback): Promise<void> {
    if (this.#tts) return;
    if (this.#initPromise) return this.#initPromise;

    const pending = this.#initialize(onProgress);
    this.#initPromise = pending;
    try {
      await pending;
    } finally {
      if (this.#initPromise === pending) this.#initPromise = undefined;
    }
  }

  async speak(
    text: string,
    options: KokoroSpeakOptions = {},
  ): Promise<void> {
    await this.#speakChunks(text, options);
  }

  async speakLong(
    text: string,
    options: KokoroLongSpeakOptions = {},
  ): Promise<void> {
    await this.#speakChunks(text, options);
  }

  async prewarm(options: KokoroPrewarmOptions = {}): Promise<void> {
    if (!this.#tts) throw new Error("KokoroTtsEngine is not initialized");
    await Promise.all([
      this.#audio(),
      this.#queueInference(
        () =>
          this.#tts!.generate(PREWARM_TEXT, {
            voice: this.#voice,
            speed: 1,
          }),
        this.#runWarmupInference,
        options.signal,
      ),
    ]);
  }

  async probe(): Promise<void> {
    await this.prewarm();
  }

  stop(): void {
    this.#generation += 1;
    const operation = this.#activeOperation;
    this.#activeOperation = undefined;
    operation?.controller.abort();
    if (operation?.splitter) {
      try {
        operation.splitter.close();
      } catch {
        // A closed splitter needs no further cancellation.
      }
    }

    for (const scheduled of [...this.#sources]) {
      try {
        scheduled.source.stop();
      } catch {
        // A source that already ended is effectively stopped.
      } finally {
        scheduled.finish();
      }
    }
    this.#sources.clear();
    this.#nextStartTime = 0;
  }

  async dispose(): Promise<void> {
    this.stop();
    const initializing = this.#initPromise;
    this.#initPromise = undefined;
    await initializing?.catch(() => undefined);
    await this.#inferenceTail.catch(() => undefined);

    const tts = this.#tts;
    this.#tts = undefined;
    this.#backend = undefined;
    this.#dtype = undefined;
    if (tts) {
      await this.#runInference(() => Promise.resolve(tts.model.dispose()));
    }

    const context = this.#audioContext;
    this.#audioContext = undefined;
    if (context && context.state !== "closed") {
      await context.close();
    }
  }

  async #initialize(onProgress?: KokoroProgressCallback): Promise<void> {
    let selected = this.#backendPreference === "auto"
      ? await selectKokoroBackend(this.#webGpuAvailable)
      : {
          backend: this.#backendPreference,
          dtype: this.#backendPreference === "webgpu"
            ? "fp32" as const
            : "q8" as const,
        };

    this.#runtime.setWasmPaths(
      this.#runtimeUrl(KOKORO_WASM_ASSET_PATH),
    );
    const fileProgress = new Map<
      string,
      { readonly loaded: number; readonly total: number }
    >();
    const emitProgress = (progress: KokoroInitProgress): void => {
      if (
        progress.file &&
        typeof progress.loaded === "number" &&
        typeof progress.total === "number" &&
        progress.total > 0
      ) {
        fileProgress.set(progress.file, {
          loaded: Math.max(0, Math.min(progress.loaded, progress.total)),
          total: progress.total,
        });
      }
      const totals = [...fileProgress.values()].reduce(
        (sum, file) => ({
          loaded: sum.loaded + file.loaded,
          total: sum.total + file.total,
        }),
        { loaded: 0, total: 0 },
      );
      onProgress?.({
        ...progress,
        ...(totals.total > 0
          ? { progress: totals.loaded / totals.total }
          : {}),
      });
    };

    const loadAndPrewarm = async (): Promise<KokoroModel> => {
      // transformers.js caches complete files through its public API.
      // The browser discards a partial failed fetch, so this layer cannot
      // resume its bytes. A retry reuses each file that completed before
      // the failure and fetches the incomplete file again.
      const loaded = await this.#queueInference(() =>
        this.#runtime.load({
          modelId: KOKORO_MODEL_ID,
          revision: KOKORO_MODEL_REVISION,
          device: selected.backend,
          dtype: selected.dtype,
          onProgress: emitProgress,
        })
      );
      try {
        await this.#queueInference(() =>
          loaded.generate(PREWARM_TEXT, {
            voice: this.#voice,
            speed: 1,
          })
        );
        return loaded;
      } catch (error) {
        await loaded.model.dispose();
        throw error;
      }
    };

    let loaded: KokoroModel;
    try {
      loaded = await loadAndPrewarm();
    } catch (error) {
      if (selected.backend !== "webgpu") throw error;
      emitProgress({ status: "fallback", progress: 0 });
      fileProgress.clear();
      selected = { backend: "wasm", dtype: "q8" };
      loaded = await loadAndPrewarm();
    }

    this.#tts = loaded;
    this.#backend = selected.backend;
    this.#dtype = selected.dtype;
    emitProgress({ status: "ready", progress: 1 });
  }

  async #speakChunks(
    text: string,
    options: KokoroLongSpeakOptions,
  ): Promise<void> {
    if (!this.#tts) throw new Error("KokoroTtsEngine is not initialized");
    const normalized = normalizeTtsText(text);
    if (!normalized) return;

    this.stop();
    const operation: ActiveOperation = {
      generation: this.#generation,
      controller: new AbortController(),
      splitter: undefined,
    };
    this.#activeOperation = operation;
    const splitter = this.#runtime.createSplitter();
    operation.splitter = splitter;
    const chunks = splitTextForKokoro(normalized, () => splitter);
    operation.splitter = undefined;

    const offsets: number[] = [];
    let searchStart = 0;
    for (const chunk of chunks) {
      const found = normalized.indexOf(chunk, searchStart);
      const offset = found < 0 ? searchStart : found;
      offsets.push(offset);
      searchStart = offset + chunk.length;
    }

    if (chunks.length > 0) {
      this.#emitProgress(options, {
        charIndex: 0,
        totalChars: normalized.length,
        chunkIndex: 0,
        chunkCount: chunks.length,
        chunkCharIndex: 0,
        eventType: "start",
      });
    }

    const playback: Array<{
      readonly chunk: string;
      readonly chunkIndex: number;
      readonly offset: number;
      readonly done: Promise<void>;
    }> = [];
    let firstAudioEmitted = false;

    try {
      for (const [chunkIndex, chunk] of chunks.entries()) {
        throwIfAborted(operation.controller.signal);
        await this.#waitForLookahead(operation.controller.signal);
        const audio = await abortable(
          this.#queueInference(() =>
            this.#tts!.generate(chunk, {
              voice: options.voice ?? this.#voice,
              speed: options.rate ?? 1,
            })
          ),
          operation.controller.signal,
        );
        throwIfAborted(operation.controller.signal);
        if (
          !(audio.data instanceof Float32Array) ||
          audio.data.length === 0 ||
          audio.sampling_rate !== KOKORO_SAMPLE_RATE
        ) {
          throw new Error("Kokoro returned invalid 24 kHz mono PCM");
        }

        const scheduled = await this.#scheduleAudio(
          audio.data,
          options.volume,
          operation.controller.signal,
        );
        if (!firstAudioEmitted) {
          firstAudioEmitted = true;
          options.onFirstAudio?.();
        }
        const offset = offsets[chunkIndex] ?? 0;
        playback.push({ chunk, chunkIndex, offset, done: scheduled.done });
        this.#emitProgress(options, {
          charIndex: offset,
          totalChars: normalized.length,
          chunkIndex,
          chunkCount: chunks.length,
          chunkCharIndex: 0,
          eventType: "sentence",
        });
      }

      for (const item of playback) {
        await abortable(item.done, operation.controller.signal);
        this.#emitProgress(options, {
          charIndex: Math.min(
            normalized.length,
            item.offset + item.chunk.length,
          ),
          totalChars: normalized.length,
          chunkIndex: item.chunkIndex,
          chunkCount: chunks.length,
          chunkCharIndex: item.chunk.length,
          eventType: "end",
        });
      }
    } catch (error) {
      if (
        operation.controller.signal.aborted &&
        error instanceof DOMException &&
        error.name === "AbortError"
      ) {
        return;
      }
      throw error;
    } finally {
      if (this.#activeOperation === operation) {
        this.#activeOperation = undefined;
      }
    }
  }

  #queueInference<T>(
    task: () => Promise<T>,
    runInference = this.#runInference,
    signal?: AbortSignal,
  ): Promise<T> {
    const pending = this.#inferenceTail
      .catch(() => undefined)
      .then(() => {
        if (signal) throwIfAborted(signal);
        return runInference(task, signal);
      });
    this.#inferenceTail = pending.catch(() => undefined);
    return pending;
  }

  async #audio(): Promise<AudioContext> {
    this.#audioContext ??= this.#audioContextFactory();
    if (this.#audioContext.state === "suspended") {
      await this.#audioContext.resume();
    }
    if (this.#audioContext.state !== "running") {
      throw new Error(
        `Kokoro audio context is ${this.#audioContext.state}`,
      );
    }
    return this.#audioContext;
  }

  async #waitForLookahead(signal: AbortSignal): Promise<void> {
    while (this.#sources.size >= MAX_AUDIO_LOOKAHEAD) {
      await abortable(
        Promise.race([...this.#sources].map((scheduled) => scheduled.done)),
        signal,
      );
    }
  }

  async #scheduleAudio(
    pcm: Float32Array,
    volume: number | undefined,
    signal: AbortSignal,
  ): Promise<ScheduledAudio> {
    const context = await this.#audio();
    throwIfAborted(signal);
    const buffer = context.createBuffer(1, pcm.length, KOKORO_SAMPLE_RATE);
    buffer.getChannelData(0).set(pcm);
    const source = context.createBufferSource();
    source.buffer = buffer;
    if (volume === undefined) {
      source.connect(context.destination);
    } else {
      const gain = context.createGain();
      gain.gain.value = Math.max(0, Math.min(1, volume));
      source.connect(gain).connect(context.destination);
    }

    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    let finished = false;
    const scheduled: ScheduledAudio = {
      source,
      done,
      finish: () => {
        if (finished) return;
        finished = true;
        source.onended = null;
        source.buffer = null;
        this.#sources.delete(scheduled);
        resolveDone();
      },
    };
    source.onended = () => {
      scheduled.finish();
    };
    this.#sources.add(scheduled);

    const previousNextStartTime = this.#nextStartTime;
    const startAt = Math.max(context.currentTime, this.#nextStartTime);
    this.#nextStartTime = startAt + buffer.duration;
    try {
      source.start(startAt);
    } catch (error) {
      this.#nextStartTime = previousNextStartTime;
      scheduled.finish();
      throw error;
    }
    return scheduled;
  }

  #emitProgress(
    options: KokoroLongSpeakOptions,
    progress: TtsProgress,
  ): void {
    try {
      options.onProgress?.(progress);
    } catch (error) {
      console.warn("Kokoro TTS progress callback failed", error);
    }
  }
}
