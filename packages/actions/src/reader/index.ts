import { defineAction } from "@sotto/core";
import type {
  ActionCommand,
  JsonSchema,
  PageActionServices,
} from "@sotto/core";

export interface ReaderCommand extends ActionCommand {
  readonly action: "reader";
}

export const readerSchema = {
  type: "object",
  properties: {
    action: { const: "reader" },
  },
  required: ["action"],
  additionalProperties: false,
} as const satisfies JsonSchema;

function requirePageServices(
  page: PageActionServices | undefined,
): PageActionServices {
  if (!page) {
    throw new Error("Reader requires the worker page-service bridge");
  }
  return page;
}

const reader = defineAction<ReaderCommand>({
  id: "reader",
  title: "Open reader",
  permissions: ["activeTab", "scripting", "tabs", "tts"],
  schema: readerSchema,
  examples: [
    {
      say: "show me this article",
      emit: { action: "reader" },
    },
    {
      say: "open the reader",
      emit: { action: "reader" },
    },
    {
      say: "show this page in reader view",
      emit: { action: "reader" },
    },
    {
      say: "let me read this article",
      emit: { action: "reader" },
    },
  ],
  confirm: false,
  async execute(_command, context) {
    const page = await requirePageServices(context.page).extract({
      preferSelection: false,
    });
    return {
      spoken: "Reader is open.",
      pageText: {
        text: page.text,
        ...(page.title ? { title: page.title } : {}),
        ...(page.language === undefined ? {} : { lang: page.language }),
        speech: "none",
        view: "reader",
      },
    };
  },
});

export default reader;
