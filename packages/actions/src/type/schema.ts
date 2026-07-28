import type { JsonSchema } from "@sotto/core";
import { REWRITE_TRANSFORMATIONS } from "./types.js";

export const typeActionSchema = {
  oneOf: [
    {
      type: "object",
      properties: {
        action: { const: "type" },
        operation: { const: "dictate" },
        text: {
          type: "string",
          minLength: 1,
          maxLength: 5_000,
          description:
            "The exact text to type, copied only from the user's transcript",
        },
      },
      required: ["action", "operation", "text"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        action: { const: "type" },
        operation: { const: "rewrite" },
        transformation: {
          type: "string",
          enum: REWRITE_TRANSFORMATIONS,
          description:
            "A closed rewrite operation selected only from the user's transcript",
        },
      },
      required: ["action", "operation", "transformation"],
      additionalProperties: false,
    },
  ],
} as const satisfies JsonSchema;
