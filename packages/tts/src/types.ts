export interface TtsSpeakOptions {
  readonly lang?: string;
  readonly rate?: number;
  readonly pitch?: number;
  readonly volume?: number;
}

export type TtsProgressEventType =
  | "start"
  | "word"
  | "sentence"
  | "marker"
  | "end";

export interface TtsProgress {
  /** Character offset in the normalized text passed to `speakLong`. */
  readonly charIndex: number;
  readonly totalChars: number;
  readonly chunkIndex: number;
  readonly chunkCount: number;
  readonly chunkCharIndex: number;
  readonly eventType: TtsProgressEventType;
}

export interface TtsLongSpeakOptions extends TtsSpeakOptions {
  readonly onProgress?: (progress: TtsProgress) => void;
}

export interface TtsEngine {
  speak(text: string, options?: TtsSpeakOptions): Promise<void>;
  stop(): void;
}

export interface LongFormTtsEngine extends TtsEngine {
  speakLong(text: string, options?: TtsLongSpeakOptions): Promise<void>;
}
