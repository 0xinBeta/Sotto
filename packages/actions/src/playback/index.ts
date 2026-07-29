import { defineAction } from "@sotto/core";
import type { ActionCommand, JsonSchema } from "@sotto/core";

export type PlaybackOperation = "pause" | "resume" | "stop" | "skip";

export interface PlaybackCommand extends ActionCommand {
  readonly action: "playback";
  readonly operation: PlaybackOperation;
}

export const playbackSchema = {
  type: "object",
  properties: {
    action: { const: "playback" },
    operation: {
      type: "string",
      enum: ["pause", "resume", "stop", "skip"],
    },
  },
  required: ["action", "operation"],
  additionalProperties: false,
} as const satisfies JsonSchema;

const playback = defineAction<PlaybackCommand>({
  id: "playback",
  title: "Control reading",
  permissions: ["tts"],
  schema: playbackSchema,
  examples: [
    {
      say: "pause",
      emit: { action: "playback", operation: "pause" },
    },
    {
      say: "pause reading",
      emit: { action: "playback", operation: "pause" },
    },
    {
      say: "resume",
      emit: { action: "playback", operation: "resume" },
    },
    {
      say: "continue reading",
      emit: { action: "playback", operation: "resume" },
    },
    {
      say: "stop reading",
      emit: { action: "playback", operation: "stop" },
    },
    {
      say: "stop",
      emit: { action: "playback", operation: "stop" },
    },
    {
      say: "skip",
      emit: { action: "playback", operation: "skip" },
    },
    {
      say: "next sentence",
      emit: { action: "playback", operation: "skip" },
    },
  ],
  confirm: false,
  async execute(command) {
    const spoken = command.operation === "pause"
      ? "Reading paused."
      : command.operation === "resume"
        ? "Reading resumed."
        : command.operation === "skip"
          ? "Skipped one sentence."
          : "Reading stopped.";
    return { spoken };
  },
});

export default playback;
