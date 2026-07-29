import type {
  ActionDefinition,
  ActionRegistry,
  JsonSchema,
} from "@sotto/core";

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

/**
 * Chrome does not document a numeric JSON Schema size or branch limit.
 * A constraint can use session context, and callers can measure that usage:
 * https://developer.chrome.com/docs/ai/prompt-api#json-schema
 * Unsupported schema features reject with NotSupportedError. A response that
 * cannot satisfy the schema rejects with SyntaxError:
 * https://github.com/webmachinelearning/prompt-api#structured-output-with-json-schema-or-regexp-constraints
 */
export function composeActionSelectionConstraint(
  registry: ActionRegistry,
): JsonSchema {
  return {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: [...registry.list().map((action) => action.id), "unknown"],
      },
    },
    required: ["action"],
    additionalProperties: false,
  };
}

export function composeActionConstraint(
  action: ActionDefinition,
): JsonSchema {
  return action.schema;
}

function schemaHasCommandParameter(schema: JsonSchema): boolean {
  if (
    Object.keys(schema.properties ?? {}).some((key) => key !== "action")
  ) {
    return true;
  }
  return [...(schema.oneOf ?? []), ...(schema.anyOf ?? [])].some(
    schemaHasCommandParameter,
  );
}

export function actionHasParameters(action: ActionDefinition): boolean {
  return schemaHasCommandParameter(action.schema);
}

export function asResponseConstraint(
  schema: JsonSchema,
): Record<string, unknown> {
  return schema as Record<string, unknown>;
}
