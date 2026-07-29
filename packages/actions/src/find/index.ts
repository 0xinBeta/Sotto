import { defineAction } from "@sotto/core";
import type {
  ActionContext,
  FindActionServices,
  JsonSchema,
} from "@sotto/core";

export type FindOperation = "search" | "next" | "clear";

export type FindCommand =
  | {
      readonly action: "find";
      readonly operation: "search";
      readonly query: string;
    }
  | {
      readonly action: "find";
      readonly operation: "next" | "clear";
    };

function operationSchema(operation: "next" | "clear"): JsonSchema {
  return {
    type: "object",
    properties: {
      action: { const: "find" },
      operation: { const: operation },
    },
    required: ["action", "operation"],
    additionalProperties: false,
  };
}

export const findSchema = {
  oneOf: [
    {
      type: "object",
      properties: {
        action: { const: "find" },
        operation: { const: "search" },
        query: {
          type: "string",
          minLength: 1,
          maxLength: 100,
          pattern: "\\S",
        },
      },
      required: ["action", "operation", "query"],
      additionalProperties: false,
    },
    operationSchema("next"),
    operationSchema("clear"),
  ],
} as const satisfies JsonSchema;

function servicesFrom(context: ActionContext): FindActionServices {
  if (!context.find) {
    throw new Error("Find requires worker find services in ActionContext");
  }
  return context.find;
}

const find = defineAction<FindCommand>({
  id: "find",
  title: "Find in page",
  permissions: ["activeTab", "scripting", "tabs"],
  schema: findSchema,
  examples: [
    {
      say: "find pricing on this page",
      emit: { action: "find", operation: "search", query: "pricing" },
    },
    {
      say: "find privacy",
      emit: { action: "find", operation: "search", query: "privacy" },
    },
    {
      say: "next match",
      emit: { action: "find", operation: "next" },
    },
    {
      say: "clear the search",
      emit: { action: "find", operation: "clear" },
    },
  ],
  confirm: false,
  async execute(command, context) {
    const operation = command.operation === "search"
      ? { operation: "search" as const, query: command.query.trim() }
      : { operation: command.operation };
    const result = await servicesFrom(context).run(operation);

    if (result.availability === "unavailable") {
      return { spoken: "I cannot search this page." };
    }
    if (command.operation === "search") {
      return {
        spoken: result.matches === 0
          ? "No matches."
          : `${result.matches} matches.`,
      };
    }
    if (command.operation === "next" && result.wrapped) {
      return { spoken: "Back to the first match." };
    }
    return { spoken: "", silent: true };
  },
});

export default find;
