export interface TtsSpeakOptions {
  readonly lang?: string;
  readonly rate?: number;
  readonly pitch?: number;
  readonly volume?: number;
}

export interface TtsEngine {
  speak(text: string, options?: TtsSpeakOptions): Promise<void>;
  stop(): void;
}
