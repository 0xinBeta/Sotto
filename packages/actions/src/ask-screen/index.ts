import { defineAction } from "@sotto/core";
import type {
  ActionCommand,
  JsonSchema,
  ScreenQuestionServices,
} from "@sotto/core";
import { captureVisiblePng } from "../screenshot/capture.js";

export interface AskScreenCommand extends ActionCommand {
  readonly action: "ask-screen";
  readonly question?: string;
}

export const askScreenSchema = {
  type: "object",
  properties: {
    action: { const: "ask-screen" },
    question: { type: "string", minLength: 1, maxLength: 1_000 },
  },
  required: ["action"],
  additionalProperties: false,
} as const satisfies JsonSchema;

function requireScreenServices(
  screen: ScreenQuestionServices | undefined,
): ScreenQuestionServices {
  if (!screen) {
    throw new Error("Screen questions require the worker screen-service bridge");
  }
  return screen;
}

const askScreen = defineAction<AskScreenCommand>({
  id: "ask-screen",
  title: "Ask about the screen",
  permissions: ["activeTab", "tts"],
  schema: askScreenSchema,
  examples: [
    {
      say: "what is on my screen",
      emit: { action: "ask-screen" },
    },
    {
      say: "what is this chart",
      emit: {
        action: "ask-screen",
        question: "What is this chart?",
      },
    },
    {
      say: "describe what I see",
      emit: { action: "ask-screen" },
    },
  ],
  confirm: false,
  async execute(command, context) {
    const screen = requireScreenServices(context.screen);
    const capture = await captureVisiblePng(command, "Screen");
    if (!capture.ok) return capture.result;

    const result = await screen.ask({
      imageDataUrl: capture.dataUrl,
      ...(command.question === undefined
        ? {}
        : { question: command.question }),
    });
    if (result.availability === "unavailable") {
      return {
        spoken: "Screen questions need a newer Chrome AI model.",
      };
    }

    return {
      spoken: "Here is what I see.",
      pageText: {
        text: result.text,
        title: "Answer about this screen",
        speech: "short",
      },
    };
  },
});

export default askScreen;
