import { defineDestination } from "@sotto/core";
import type { ImageDestinationInput } from "@sotto/core";
import { createClipboardWorkflow } from "../workflow.js";

const copyDestination = defineDestination<ImageDestinationInput>({
  id: "copy",
  title: "Copy",
  permissions: [],
  async execute(input) {
    return {
      spoken: "Screenshot ready. Click Copy in Sotto.",
      workflow: createClipboardWorkflow(input),
    };
  },
});

export default copyDestination;
