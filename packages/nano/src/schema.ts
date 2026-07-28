import type { ActionRegistry, JsonSchema } from "@sotto/core";

const UNKNOWN_SCHEMA = {
  type: "object",
  properties: {
    action: { const: "unknown" },
  },
  required: ["action"],
  additionalProperties: false,
} as const satisfies JsonSchema;

/**
 * Composes the strict command union consumed by LanguageModel.prompt().
 * A new plugin contributes its complete command schema through the registry.
 */
export function composeResponseConstraint(
  registry: ActionRegistry,
): JsonSchema {
  return {
    oneOf: [
      ...registry.list().map((action) => action.schema),
      UNKNOWN_SCHEMA,
    ],
  };
}

export function asResponseConstraint(
  schema: JsonSchema,
): Record<string, unknown> {
  return schema as Record<string, unknown>;
}
