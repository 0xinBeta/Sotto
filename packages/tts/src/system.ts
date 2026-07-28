import {
  chunkTextForTts,
  MAX_TTS_UTTERANCE_LENGTH,
  normalizeTtsText,
} from "./chunker.js";
import type {
  LongFormTtsEngine,
  TtsLongSpeakOptions,
  TtsProgress,
  TtsProgressEventType,
  TtsSpeakOptions,
} from "./types.js";

const DEFAULT_LANGUAGE = "en-US";
const MIN_WATCHDOG_MS = 60_000;
const WATCHDOG_MS_PER_CHARACTER = 150;

type SuccessfulFinalEvent = "end" | "interrupted" | "cancelled";

interface ActiveUtterance {
  cancel(): void;
}

interface VoiceSelection {
  readonly lang: string;
  readonly voiceName?: string;
}

function languageMatches(voiceLanguage: string, requestedLanguage: string): boolean {
  const voice = voiceLanguage.toLowerCase();
  const requested = requestedLanguage.toLowerCase();
  const requestedBase = requested.split("-")[0];

  return voice === requested ||
    (requestedBase !== undefined && voice.startsWith(`${requestedBase}-`));
}

function assertUtteranceLength(utterance: string): void {
  if (utterance.length > MAX_TTS_UTTERANCE_LENGTH) {
    throw new Error(
      `System TTS utterances must be shorter than 32,768 characters; received ${utterance.length}`,
    );
  }
}

function watchdogDelay(utteranceLength: number, rate: number | undefined): number {
  const effectiveRate = rate === undefined || rate <= 0 ? 1 : rate;
  return Math.max(
    MIN_WATCHDOG_MS,
    Math.ceil(utteranceLength * WATCHDOG_MS_PER_CHARACTER / effectiveRate),
  );
}

function isProgressEvent(
  type: string,
): type is Exclude<TtsProgressEventType, "end"> {
  return type === "start" ||
    type === "word" ||
    type === "sentence" ||
    type === "marker";
}

export class SystemTtsEngine implements LongFormTtsEngine {
  private generation = 0;
  private activeUtterance: ActiveUtterance | undefined;

  async speak(
    text: string,
    options: TtsSpeakOptions = {},
  ): Promise<void> {
    const generation = this.beginOperation();
    const utterance = text.trim();
    if (!utterance) {
      return;
    }
    assertUtteranceLength(utterance);

    let voice: VoiceSelection;
    try {
      voice = await this.selectVoice(options.lang ?? DEFAULT_LANGUAGE);
    } catch (error) {
      if (generation !== this.generation) {
        return;
      }
      throw error;
    }
    if (generation !== this.generation) {
      return;
    }

    await this.speakUntilFinalEvent(utterance, voice, options);
  }

  async speakLong(
    text: string,
    options: TtsLongSpeakOptions = {},
  ): Promise<void> {
    const generation = this.beginOperation();
    const normalized = normalizeTtsText(text);
    const chunks = chunkTextForTts(normalized);
    if (chunks.length === 0) {
      return;
    }

    let voice: VoiceSelection;
    try {
      voice = await this.selectVoice(options.lang ?? DEFAULT_LANGUAGE);
    } catch (error) {
      if (generation !== this.generation) {
        return;
      }
      throw error;
    }
    if (generation !== this.generation) {
      return;
    }

    let searchStart = 0;
    let lastProgress = -1;

    for (const [chunkIndex, chunk] of chunks.entries()) {
      if (generation !== this.generation) {
        return;
      }
      assertUtteranceLength(chunk);

      const foundOffset = normalized.indexOf(chunk, searchStart);
      const chunkOffset = foundOffset < 0 ? searchStart : foundOffset;
      searchStart = chunkOffset + chunk.length;

      const reportProgress = (
        chunkCharIndex: number,
        eventType: TtsProgressEventType,
      ): void => {
        const boundedChunkIndex = Math.max(
          0,
          Math.min(chunk.length, chunkCharIndex),
        );
        const charIndex = Math.max(
          lastProgress,
          Math.min(normalized.length, chunkOffset + boundedChunkIndex),
        );
        if (charIndex === lastProgress && eventType !== "end") {
          return;
        }
        lastProgress = charIndex;

        const progress: TtsProgress = {
          charIndex,
          totalChars: normalized.length,
          chunkIndex,
          chunkCount: chunks.length,
          chunkCharIndex: boundedChunkIndex,
          eventType,
        };
        try {
          options.onProgress?.(progress);
        } catch (error) {
          console.warn("System TTS progress callback failed", error);
        }
      };

      if (lastProgress < chunkOffset) {
        reportProgress(0, "start");
      }

      const finalEvent = await this.speakUntilFinalEvent(
        chunk,
        voice,
        options,
        (event) => {
          if (
            generation === this.generation &&
            isProgressEvent(event.type) &&
            typeof event.charIndex === "number" &&
            Number.isFinite(event.charIndex)
          ) {
            reportProgress(event.charIndex, event.type);
          }
        },
      );

      if (generation !== this.generation || finalEvent !== "end") {
        return;
      }
      reportProgress(chunk.length, "end");
    }
  }

  stop(): void {
    this.invalidateAndStop();
  }

  private beginOperation(): number {
    this.invalidateAndStop();
    return this.generation;
  }

  private invalidateAndStop(): void {
    this.generation += 1;
    const active = this.activeUtterance;

    try {
      chrome.tts.stop();
    } catch (error) {
      console.warn("Unable to stop system TTS playback", error);
    }

    active?.cancel();
  }

  private async selectVoice(requestedLanguage: string): Promise<VoiceSelection> {
    let voices: chrome.tts.TtsVoice[];
    try {
      voices = await chrome.tts.getVoices();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Unable to enumerate system TTS voices: ${detail}`);
    }

    const voice = voices.find((candidate) =>
      candidate.remote !== true &&
      typeof candidate.lang === "string" &&
      languageMatches(candidate.lang, requestedLanguage)
    );
    if (!voice?.lang) {
      throw new Error(`No local TTS voice is available for ${requestedLanguage}`);
    }

    return {
      lang: voice.lang,
      ...(voice.voiceName === undefined ? {} : { voiceName: voice.voiceName }),
    };
  }

  private speakUntilFinalEvent(
    utterance: string,
    voice: VoiceSelection,
    options: TtsSpeakOptions,
    onEvent?: (event: chrome.tts.TtsEvent) => void,
  ): Promise<SuccessfulFinalEvent> {
    assertUtteranceLength(utterance);

    return new Promise<SuccessfulFinalEvent>((resolve, reject) => {
      let finished = false;
      let timeout: ReturnType<typeof setTimeout>;
      const timeoutDelay = watchdogDelay(utterance.length, options.rate);

      const finish = (
        result: SuccessfulFinalEvent | Error,
      ): void => {
        if (finished) {
          return;
        }
        finished = true;
        clearTimeout(timeout);
        if (this.activeUtterance === activeUtterance) {
          this.activeUtterance = undefined;
        }

        if (result instanceof Error) {
          reject(result);
        } else {
          resolve(result);
        }
      };

      const resetWatchdog = (): void => {
        clearTimeout(timeout);
        timeout = setTimeout(
          () => finish(new Error("System TTS playback timed out")),
          timeoutDelay,
        );
      };

      const activeUtterance: ActiveUtterance = {
        cancel: () => finish("cancelled"),
      };
      this.activeUtterance = activeUtterance;
      resetWatchdog();

      const ttsOptions: chrome.tts.TtsOptions = {
        enqueue: false,
        lang: voice.lang,
        ...(voice.voiceName === undefined
          ? {}
          : { voiceName: voice.voiceName }),
        ...(options.rate === undefined ? {} : { rate: options.rate }),
        ...(options.pitch === undefined ? {} : { pitch: options.pitch }),
        ...(options.volume === undefined ? {} : { volume: options.volume }),
        onEvent: (event) => {
          if (finished) {
            return;
          }

          switch (event.type) {
            case "end":
              finish("end");
              break;
            case "interrupted":
            case "cancelled":
              finish(event.type);
              break;
            case "error":
              finish(
                new Error(
                  `System TTS playback failed: ${event.errorMessage ?? "Unknown TTS error"}`,
                ),
              );
              break;
            default:
              resetWatchdog();
              onEvent?.(event);
              break;
          }
        },
      };

      try {
        const started = chrome.tts.speak(utterance, ttsOptions) as unknown;
        if (
          typeof started === "object" &&
          started !== null &&
          "then" in started
        ) {
          void Promise.resolve(started).catch((error: unknown) => {
            finish(
              error instanceof Error
                ? error
                : new Error(`System TTS playback failed: ${String(error)}`),
            );
          });
        }
      } catch (error) {
        finish(
          error instanceof Error
            ? error
            : new Error(`System TTS playback failed: ${String(error)}`),
        );
      }
    });
  }
}
