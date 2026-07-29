import { defineDestination } from "@sotto/core";
import type { ImageDestinationInput } from "@sotto/core";
import { createClipboardWorkflow } from "../workflow.js";

const geminiDestination = defineDestination<ImageDestinationInput>({
  id: "gemini",
  title: "Gemini",
  permissions: ["clipboardWrite", "tabs"],
  async execute(input) {
    return {
      spoken: "Screenshot ready. Click Copy to open Gemini.",
      workflow: createClipboardWorkflow(input, {
        buttonLabel: "Copy and open Gemini",
        afterWrite: {
          followUp: {
            kind: "focus-or-open-tab",
            matchPatterns: ["https://gemini.google.com/*"],
            createUrl: "https://gemini.google.com/app",
          },
          spoken: "Paste-ready — press Control V.",
        },
      }),
    };
  },
});

export default geminiDestination;
