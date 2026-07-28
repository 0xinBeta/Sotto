import { defineDestination } from "@sotto/core";
import type { ImageDestinationInput } from "@sotto/core";
import { createClipboardWorkflow } from "../workflow.js";

const claudeDestination = defineDestination<ImageDestinationInput>({
  id: "claude",
  title: "Claude",
  permissions: ["clipboardWrite", "tabs"],
  async execute(input) {
    return {
      spoken: "Screenshot ready. Click Copy to open Claude.",
      workflow: createClipboardWorkflow(input, {
        buttonLabel: "Copy and open Claude",
        afterWrite: {
          followUp: {
            kind: "focus-or-open-tab",
            matchPatterns: ["https://claude.ai/*"],
            createUrl: "https://claude.ai/new",
          },
          spoken: "Paste-ready — hit Control V.",
        },
      }),
    };
  },
});

export default claudeDestination;
