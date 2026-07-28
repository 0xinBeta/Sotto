import type { TtsEngine, TtsSpeakOptions } from "./types.js";

const DEFAULT_LANGUAGE = "en-US";

function languageMatches(voiceLanguage: string, requestedLanguage: string): boolean {
  const voice = voiceLanguage.toLowerCase();
  const requested = requestedLanguage.toLowerCase();
  const requestedBase = requested.split("-")[0];

  return voice === requested ||
    (requestedBase !== undefined && voice.startsWith(`${requestedBase}-`));
}

export class SystemTtsEngine implements TtsEngine {
  async speak(
    text: string,
    options: TtsSpeakOptions = {},
  ): Promise<void> {
    const utterance = text.trim();
    if (!utterance) {
      return;
    }

    const lang = options.lang ?? DEFAULT_LANGUAGE;

    let voices: chrome.tts.TtsVoice[];
    try {
      voices = await chrome.tts.getVoices();
    } catch (error) {
      console.warn("Unable to enumerate system TTS voices", error);
      return;
    }

    const voice = voices.find((candidate) =>
      candidate.remote !== true &&
      typeof candidate.lang === "string" &&
      languageMatches(candidate.lang, lang)
    );

    if (!voice) {
      console.warn(`No local TTS voice is available for ${lang}`);
      return;
    }

    const voiceLanguage = voice.lang;
    if (!voiceLanguage) {
      console.warn(`No local TTS voice is available for ${lang}`);
      return;
    }

    await new Promise<void>((resolve) => {
      let finished = false;

      const finish = (error?: unknown): void => {
        if (finished) {
          return;
        }
        finished = true;

        if (error !== undefined) {
          console.warn("System TTS playback failed", error);
        }
        resolve();
      };

      try {
        const ttsOptions: chrome.tts.TtsOptions = {
          enqueue: false,
          lang: voiceLanguage,
          ...(voice.voiceName === undefined
            ? {}
            : { voiceName: voice.voiceName }),
          ...(options.rate === undefined ? {} : { rate: options.rate }),
          ...(options.pitch === undefined ? {} : { pitch: options.pitch }),
          ...(options.volume === undefined ? {} : { volume: options.volume }),
          onEvent(event) {
            switch (event.type) {
              case "end":
              case "interrupted":
              case "cancelled":
                finish();
                break;
              case "error":
                finish(event.errorMessage ?? "Unknown TTS error");
                break;
              default:
                break;
            }
          },
        };
        const started = chrome.tts.speak(utterance, ttsOptions) as unknown;

        if (
          typeof started === "object" &&
          started !== null &&
          "then" in started
        ) {
          void Promise.resolve(started).catch(finish);
        }
      } catch (error) {
        finish(error);
      }
    });
  }

  stop(): void {
    try {
      chrome.tts.stop();
    } catch (error) {
      console.warn("Unable to stop system TTS playback", error);
    }
  }
}
