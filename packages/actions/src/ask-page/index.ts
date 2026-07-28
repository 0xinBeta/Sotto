import { defineAction } from "@sotto/core";
import type {
  ActionCommand,
  JsonSchema,
  PageActionServices,
} from "@sotto/core";

export interface AskPageCommand extends ActionCommand {
  readonly action: "ask-page";
  readonly question: string;
  readonly scope: "page" | "selection";
}

export const askPageSchema = {
  type: "object",
  properties: {
    action: { const: "ask-page" },
    question: { type: "string", minLength: 1, maxLength: 1_000 },
    scope: { type: "string", enum: ["page", "selection"] },
  },
  required: ["action", "question", "scope"],
  additionalProperties: false,
} as const satisfies JsonSchema;

function requirePageServices(
  page: PageActionServices | undefined,
): PageActionServices {
  if (!page) {
    throw new Error("Ask Page requires the worker page-service bridge");
  }
  return page;
}

const askPage = defineAction<AskPageCommand>({
  id: "ask-page",
  title: "Ask this page",
  permissions: ["activeTab", "scripting", "tts"],
  schema: askPageSchema,
  examples: [
    {
      say: "what does this article say about pricing?",
      emit: {
        action: "ask-page",
        question: "What does this article say about pricing?",
        scope: "page",
      },
    },
    {
      say: "explain this selection",
      emit: {
        action: "ask-page",
        question: "Explain this.",
        scope: "selection",
      },
    },
    {
      say: "according to this page, when does the plan launch?",
      emit: {
        action: "ask-page",
        question: "When does the plan launch?",
        scope: "page",
      },
    },
  ],
  confirm: false,
  async execute(command, context) {
    const service = requirePageServices(context.page);
    const selection = command.scope === "selection";
    const page = await service.extract({
      // A current selection is the narrowest and most relevant Ask Page
      // context, even when the transcript did not explicitly say "selection".
      preferSelection: true,
      ...(selection ? { requireSelection: true } : {}),
    });
    const answer = await service.runModelTask({
      role: "ask-page",
      page,
      question: command.question,
    });
    return {
      spoken: "Here is what the page says.",
      pageText: {
        text: answer,
        title: page.title ? `Answer — ${page.title}` : "Answer from this page",
        speech: "short",
      },
    };
  },
});

export default askPage;
