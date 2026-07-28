import { defineAction } from "@sotto/core";
import type {
  ActionCommand,
  JsonSchema,
  PageActionServices,
} from "@sotto/core";

export type SummarizeMode = "summarize" | "read";
export type PageScope = "page" | "selection";

export interface SummarizeCommand extends ActionCommand {
  readonly action: "summarize";
  readonly mode: SummarizeMode;
  readonly scope: PageScope;
}

export const summarizeSchema = {
  type: "object",
  properties: {
    action: { const: "summarize" },
    mode: { type: "string", enum: ["summarize", "read"] },
    scope: { type: "string", enum: ["page", "selection"] },
  },
  required: ["action", "mode", "scope"],
  additionalProperties: false,
} as const satisfies JsonSchema;

function requirePageServices(
  page: PageActionServices | undefined,
): PageActionServices {
  if (!page) {
    throw new Error("Page actions require the worker page-service bridge");
  }
  return page;
}

const summarize = defineAction<SummarizeCommand>({
  id: "summarize",
  title: "Summarize or read page",
  permissions: ["activeTab", "scripting", "tts"],
  schema: summarizeSchema,
  examples: [
    {
      say: "summarize this page",
      emit: { action: "summarize", mode: "summarize", scope: "page" },
    },
    {
      say: "give me the TL;DR",
      emit: { action: "summarize", mode: "summarize", scope: "page" },
    },
    {
      say: "summarize my selection",
      emit: {
        action: "summarize",
        mode: "summarize",
        scope: "selection",
      },
    },
    {
      say: "read this page",
      emit: { action: "summarize", mode: "read", scope: "page" },
    },
    {
      say: "read my selection",
      emit: { action: "summarize", mode: "read", scope: "selection" },
    },
  ],
  confirm: false,
  async execute(command, context) {
    const service = requirePageServices(context.page);
    const selection = command.scope === "selection";
    const page = await service.extract({
      preferSelection: selection,
      ...(selection ? { requireSelection: true } : {}),
    });

    if (command.mode === "read") {
      return {
        spoken: "Reading the page.",
        pageText: {
          text: page.text,
          title: page.title || "Page",
          ...(page.language === undefined ? {} : { lang: page.language }),
          speech: "long",
        },
      };
    }

    const summary = await service.runModelTask({
      role: "summarize",
      page,
    });
    return {
      spoken: "Here is the summary.",
      pageText: {
        text: summary,
        title: page.title ? `Summary — ${page.title}` : "Page summary",
        speech: "long",
      },
    };
  },
});

export default summarize;
