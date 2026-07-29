import { defineAction } from "@sotto/core";
import type {
  ActionCommand,
  ActionContext,
  JsonSchema,
  MediaActionServices,
  MediaControlOperation,
} from "@sotto/core";

export type MediaOperation = MediaControlOperation;

export interface MediaCommand extends ActionCommand {
  readonly action: "media";
  readonly operation: MediaOperation;
}

export const mediaSchema = {
  type: "object",
  properties: {
    action: { const: "media" },
    operation: {
      type: "string",
      enum: ["pause", "play"],
    },
  },
  required: ["action", "operation"],
  additionalProperties: false,
} as const satisfies JsonSchema;

function servicesFrom(context: ActionContext): MediaActionServices {
  if (!context.media) {
    throw new Error("Media requires worker media services in ActionContext");
  }
  return context.media;
}

const media = defineAction<MediaCommand>({
  id: "media",
  title: "Control page media",
  permissions: ["activeTab", "scripting", "tabs"],
  schema: mediaSchema,
  examples: [
    {
      say: "pause the video",
      emit: { action: "media", operation: "pause" },
    },
    {
      say: "play the video",
      emit: { action: "media", operation: "play" },
    },
    {
      say: "pause the music",
      emit: { action: "media", operation: "pause" },
    },
    {
      say: "play the music",
      emit: { action: "media", operation: "play" },
    },
  ],
  confirm: false,
  async execute(command, context) {
    const result = await servicesFrom(context).run(command.operation);
    if (result.status === "blocked") {
      return {
        spoken: "The page blocked playback. Click the video once.",
      };
    }
    if (result.status === "no-media") {
      return { spoken: "I found no video or audio here." };
    }
    return {
      spoken: result.status === "paused" ? "Paused." : "Playing.",
    };
  },
});

export default media;
