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
}

export interface SttEngine {
  init(onProgress?: SttProgressCallback): Promise<void>;
  transcribe(
    audio: Float32Array,
    options?: SttTranscriptionOptions,
  ): Promise<string>;
  dispose(): Promise<void>;
}
