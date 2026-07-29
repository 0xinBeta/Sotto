import { KokoroTTS, TextSplitterStream, env } from "kokoro-js";

import { normalizeTtsText } from "./chunker.js";
import {
  KOKORO_VOICE,
  type KokoroVoiceId,
} from "./kokoro-voices.js";
import type {
  LongFormTtsEngine,
  TtsLongSpeakOptions,
  TtsPlaybackState,
  TtsProgress,
  TtsSpeakOptions,
} from "./types.js";

export {
  isKokoroVoiceId,
  KOKORO_VOICE,
  KOKORO_VOICES,
  type KokoroVoice,
  type KokoroVoiceId,
} from "./kokoro-voices.js";

export const KOKORO_MODEL_ID =
  "onnx-community/Kokoro-82M-v1.0-ONNX";
export const KOKORO_MODEL_REVISION =
  "1939ad2a8e416c0acfeecc08a694d14ef25f2231";
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
  readonly audio: Float32Array;
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
  start(): void;
  finish(): void;
}

interface ActiveOperation {
  readonly generation: number;
  readonly controller: AbortController;
  readonly longForm: boolean;
  readonly prepared: Map<number, ScheduledAudio>;
  splitter: Splitter | undefined;
  current: ScheduledAudio | undefined;
  paused: boolean;
  pendingSkips: number;
  producerDone: boolean;
  producerError: unknown;
  notify: (() => void) | undefined;
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
  #generation = 0;
  #inferenceTail: Promise<unknown> = Promise.resolve();
  #backend: KokoroBackend | undefined;
  #dtype: KokoroDtype | undefined;
  #voice: KokoroVoiceId;
  #playbackState: TtsPlaybackState = "idle";

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

  get playbackState(): TtsPlaybackState {
    return this.#playbackState;
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
    await this.#speakChunks(text, options, false);
  }

  async speakLong(
    text: string,
    options: KokoroLongSpeakOptions = {},
  ): Promise<void> {
    await this.#speakChunks(text, options, true);
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
    this.#playbackState = "idle";
    const operation = this.#activeOperation;
    this.#activeOperation = undefined;
    operation?.controller.abort();
    if (operation) {
      operation.notify?.();
      operation.notify = undefined;
    }
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
  }

  pause(): boolean {
    const operation = this.#activeOperation;
    if (
      !operation?.longForm ||
      this.#playbackState !== "playing"
    ) {
      return false;
    }
    operation.paused = true;
    this.#playbackState = "paused";
    const current = operation.current;
    if (current) {
      try {
        current.source.stop();
      } catch {
        // A source that ended at the pause boundary needs no stop.
      } finally {
        current.finish();
        operation.current = undefined;
      }
    }
    return true;
  }

  resume(): boolean {
    const operation = this.#activeOperation;
    if (
      !operation?.longForm ||
      this.#playbackState !== "paused"
    ) {
      return false;
    }
    operation.paused = false;
    this.#playbackState = "playing";
    operation.notify?.();
    operation.notify = undefined;
    return true;
  }

  skip(): boolean {
    const operation = this.#activeOperation;
    if (!operation?.longForm || this.#playbackState === "idle") {
      return false;
    }
    const current = operation.current;
    if (current) {
      try {
        current.source.stop();
      } catch {
        // A source that ended at the skip boundary needs no stop.
      } finally {
        current.finish();
        operation.current = undefined;
      }
    } else {
      operation.pendingSkips += 1;
      operation.notify?.();
      operation.notify = undefined;
    }
    return true;
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

  /**
   * Rebuilds the model session after the ONNX runtime backend was destroyed
   * out from under it. Model files come from cache, so this is fast. Runs
   * inside #queueInference, so it must not re-enter the queue.
   */
  async #rebuildAfterRuntimeLoss(): Promise<void> {
    const dead = this.#tts;
    this.#tts = undefined;
    if (dead) {
      try {
        await dead.model.dispose();
      } catch {
        // The backend is already gone; disposal failure is expected.
      }
    }
    this.#tts = await this.#runtime.load({
      modelId: KOKORO_MODEL_ID,
      revision: KOKORO_MODEL_REVISION,
      device: this.#backend ?? "wasm",
      dtype: this.#dtype ?? "q8",
      onProgress: () => {},
    });
  }

  async #speakChunks(
    text: string,
    options: KokoroLongSpeakOptions,
    longForm: boolean,
  ): Promise<void> {
    if (!this.#tts) throw new Error("KokoroTtsEngine is not initialized");
    const normalized = normalizeTtsText(text);
    if (!normalized) return;

    this.stop();
    const operation: ActiveOperation = {
      generation: this.#generation,
      controller: new AbortController(),
      longForm,
      prepared: new Map(),
      splitter: undefined,
      current: undefined,
      paused: false,
      pendingSkips: 0,
      producerDone: false,
      producerError: undefined,
      notify: undefined,
    };
    this.#activeOperation = operation;
    if (longForm) this.#playbackState = "playing";
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

    let firstAudioEmitted = false;

    try {
      const producer = this.#produceAudio(
        operation,
        chunks,
        options,
      );
      void producer.catch(() => undefined);

      for (const [chunkIndex, chunk] of chunks.entries()) {
        const scheduled = await this.#waitForPrepared(
          operation,
          chunkIndex,
        );
        operation.prepared.delete(chunkIndex);
        await this.#waitUntilPlaying(operation);
        if (operation.pendingSkips > 0) {
          operation.pendingSkips -= 1;
          scheduled.finish();
          this.#emitChunkEnd(
            options,
            normalized.length,
            chunks.length,
            chunk,
            chunkIndex,
            offsets[chunkIndex] ?? 0,
          );
          continue;
        }
        throwIfAborted(operation.controller.signal);
        operation.current = scheduled;
        scheduled.start();
        if (!firstAudioEmitted) {
          firstAudioEmitted = true;
          options.onFirstAudio?.();
        }
        const offset = offsets[chunkIndex] ?? 0;
        this.#emitProgress(options, {
          charIndex: offset,
          totalChars: normalized.length,
          chunkIndex,
          chunkCount: chunks.length,
          chunkCharIndex: 0,
          eventType: "sentence",
        });
        await abortable(scheduled.done, operation.controller.signal);
        operation.current = undefined;
        this.#emitChunkEnd(
          options,
          normalized.length,
          chunks.length,
          chunk,
          chunkIndex,
          offset,
        );
      }
      await producer;
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
        if (longForm) this.#playbackState = "idle";
      }
    }
  }

  async #produceAudio(
    operation: ActiveOperation,
    chunks: readonly string[],
    options: KokoroLongSpeakOptions,
  ): Promise<void> {
    try {
      for (const [chunkIndex, chunk] of chunks.entries()) {
        throwIfAborted(operation.controller.signal);
        await this.#waitForLookahead(operation.controller.signal);
        const synthesize = () =>
          this.#tts!.generate(chunk, {
            voice: options.voice ?? this.#voice,
            // kokoro-js 1.2.1 supports synthesis-time speed, so playbackRate
            // pitch shifting is not required.
            speed: options.rate ?? 1,
          });
        const audio = await abortable(
          this.#queueInference(async () => {
            try {
              return await synthesize();
            } catch (error) {
              // A destroyed ONNX runtime backend surfaces as a TypeError on
              // internal state ("reading 'dc'" / null backend). The model
              // files stay cached, so rebuilding the session self-heals.
              if (
                error instanceof TypeError &&
                /reading|null|undefined/i.test(error.message)
              ) {
                await this.#rebuildAfterRuntimeLoss();
                return await synthesize();
              }
              throw error;
            }
          }),
          operation.controller.signal,
        );
        throwIfAborted(operation.controller.signal);
        if (
          !(audio.audio instanceof Float32Array) ||
          audio.audio.length === 0 ||
          audio.sampling_rate !== KOKORO_SAMPLE_RATE
        ) {
          throw new Error("Kokoro returned invalid 24 kHz mono PCM");
        }
        const scheduled = await this.#prepareAudio(
          audio.audio,
          options.volume,
          operation.controller.signal,
        );
        operation.prepared.set(chunkIndex, scheduled);
        operation.notify?.();
        operation.notify = undefined;
      }
    } catch (error) {
      operation.producerError = error;
      throw error;
    } finally {
      operation.producerDone = true;
      operation.notify?.();
      operation.notify = undefined;
    }
  }

  async #waitForPrepared(
    operation: ActiveOperation,
    chunkIndex: number,
  ): Promise<ScheduledAudio> {
    while (!operation.prepared.has(chunkIndex)) {
      throwIfAborted(operation.controller.signal);
      if (operation.producerDone) {
        throw operation.producerError ??
          new Error("Kokoro did not prepare the next speech chunk");
      }
      await abortable(
        new Promise<void>((resolve) => {
          operation.notify = resolve;
        }),
        operation.controller.signal,
      );
    }
    return operation.prepared.get(chunkIndex)!;
  }

  async #waitUntilPlaying(operation: ActiveOperation): Promise<void> {
    while (operation.paused && operation.pendingSkips === 0) {
      await abortable(
        new Promise<void>((resolve) => {
          operation.notify = resolve;
        }),
        operation.controller.signal,
      );
    }
  }

  #emitChunkEnd(
    options: KokoroLongSpeakOptions,
    totalChars: number,
    chunkCount: number,
    chunk: string,
    chunkIndex: number,
    offset: number,
  ): void {
    this.#emitProgress(options, {
      charIndex: Math.min(totalChars, offset + chunk.length),
      totalChars,
      chunkIndex,
      chunkCount,
      chunkCharIndex: chunk.length,
      eventType: "end",
    });
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

  async #prepareAudio(
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
    let started = false;
    const scheduled: ScheduledAudio = {
      source,
      done,
      start: () => {
        if (started) return;
        started = true;
        try {
          source.start();
        } catch (error) {
          scheduled.finish();
          throw error;
        }
      },
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
