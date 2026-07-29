import type { SpeechLanguage } from "./languages.js";

export interface SttProgress {
  readonly status: string;
  readonly file?: string;
  readonly name?: string;
  readonly progress?: number;
  readonly loaded?: number;
  readonly total?: number;
  readonly resumable?: boolean;
  readonly [key: string]: unknown;
}

export type SttProgressCallback = (progress: SttProgress) => void;

export interface SttTranscriptionOptions {
  readonly signal?: AbortSignal;
  /**
   * The requested speech language. Engines can use automatic detection when
   * their decoder does not accept language input.
   */
  readonly language?: SpeechLanguage;
}

export interface SttEngine {
  init(onProgress?: SttProgressCallback): Promise<void>;
  transcribe(
    audio: Float32Array,
    options?: SttTranscriptionOptions,
  ): Promise<string>;
  dispose(): Promise<void>;
}
