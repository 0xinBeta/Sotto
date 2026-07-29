import { defineDestination } from "@sotto/core";
import type { ImageDestinationInput } from "@sotto/core";
import { createClipboardWorkflow } from "../workflow.js";

const chatgptDestination = defineDestination<ImageDestinationInput>({
  id: "chatgpt",
  title: "ChatGPT",
  permissions: ["clipboardWrite", "tabs"],
  async execute(input) {
    return {
      spoken: "Screenshot ready. Click Copy to open ChatGPT.",
      workflow: createClipboardWorkflow(input, {
        buttonLabel: "Copy and open ChatGPT",
        afterWrite: {
          followUp: {
            kind: "focus-or-open-tab",
            matchPatterns: ["https://chatgpt.com/*"],
            createUrl: "https://chatgpt.com/",
          },
          spoken: "Paste-ready — press Control V.",
        },
      }),
    };
  },
});

export default chatgptDestination;
