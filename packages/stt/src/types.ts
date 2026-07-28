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

export interface SttEngine {
  init(onProgress?: SttProgressCallback): Promise<void>;
  transcribe(audio: Float32Array): Promise<string>;
  dispose(): Promise<void>;
}
