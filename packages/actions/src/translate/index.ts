import { defineAction } from "@sotto/core";
import type {
  ActionCommand,
  JsonSchema,
  PageActionServices,
} from "@sotto/core";

export const TRANSLATE_LANGUAGE_CODES = [
  "ar",
  "zh",
  "nl",
  "en",
  "fr",
  "de",
  "hi",
  "it",
  "ja",
  "ko",
  "pl",
  "pt",
  "ru",
  "es",
  "tr",
] as const;

export type TranslateLanguage =
  (typeof TRANSLATE_LANGUAGE_CODES)[number];

export type TranslateScope = "page" | "selection";

export interface TranslateCommand extends ActionCommand {
  readonly action: "translate";
  readonly targetLanguage: TranslateLanguage;
  readonly scope: TranslateScope;
}

export const TRANSLATE_LANGUAGE_LABELS: Readonly<
  Record<TranslateLanguage, string>
> = {
  ar: "Arabic",
  zh: "Chinese",
  nl: "Dutch",
  en: "English",
  fr: "French",
  de: "German",
  hi: "Hindi",
  it: "Italian",
  ja: "Japanese",
  ko: "Korean",
  pl: "Polish",
  pt: "Portuguese",
  ru: "Russian",
  es: "Spanish",
  tr: "Turkish",
};

export const translateSchema = {
  type: "object",
  properties: {
    action: { const: "translate" },
    targetLanguage: {
      type: "string",
      enum: TRANSLATE_LANGUAGE_CODES,
      description:
        "BCP 47 code for the target language named in the transcript.",
    },
    scope: { type: "string", enum: ["page", "selection"] },
  },
  required: ["action", "targetLanguage", "scope"],
  additionalProperties: false,
} as const satisfies JsonSchema;

function requirePageServices(
  page: PageActionServices | undefined,
): PageActionServices {
  if (!page) {
    throw new Error("Translate requires the worker page-service bridge");
  }
  return page;
}

const translate = defineAction<TranslateCommand>({
  id: "translate",
  title: "Translate page",
  permissions: ["activeTab", "scripting", "tts"],
  schema: translateSchema,
  examples: [
    {
      say: "translate this page to Spanish",
      emit: {
        action: "translate",
        targetLanguage: "es",
        scope: "page",
      },
    },
    {
      say: "translate my selection to German",
      emit: {
        action: "translate",
        targetLanguage: "de",
        scope: "selection",
      },
    },
    {
      say: "show this page in French",
      emit: {
        action: "translate",
        targetLanguage: "fr",
        scope: "page",
      },
    },
    {
      say: "translate the selected text to Japanese",
      emit: {
        action: "translate",
        targetLanguage: "ja",
        scope: "selection",
      },
    },
  ],
  confirm: false,
  async execute(command, context) {
    const service = requirePageServices(context.page);
    const selection = command.scope === "selection";
    const page = await service.extract({
      preferSelection: true,
      ...(selection ? { requireSelection: true } : {}),
    });
    const result = await service.translate({
      page,
      targetLanguage: command.targetLanguage,
    });
    if (result.availability === "unavailable") {
      return {
        spoken: "Translation is not available for this language pair.",
      };
    }

    const language = TRANSLATE_LANGUAGE_LABELS[command.targetLanguage];
    return {
      spoken: `Here is the ${language} translation.`,
      pageText: {
        text: result.text,
        title: page.title
          ? `${language} translation — ${page.title}`
          : `${language} translation`,
        lang: command.targetLanguage,
        speech: "long",
      },
    };
  },
});

export default translate;
