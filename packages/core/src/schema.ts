import type { JsonSchema, JsonValue } from "./types.js";

export interface SchemaValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

function jsonEquals(left: JsonValue, right: JsonValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function valueType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

function matchesType(value: unknown, type: NonNullable<JsonSchema["type"]>): boolean {
  const types = Array.isArray(type) ? type : [type];
  return types.some((candidate) => {
    if (candidate === "number") {
      return typeof value === "number" && Number.isFinite(value);
    }
    if (candidate === "integer") {
      return typeof value === "number" && Number.isInteger(value);
    }
    if (candidate === "object") {
      return typeof value === "object" && value !== null && !Array.isArray(value);
    }
    return valueType(value) === candidate;
  });
}

function validateNode(
  schema: JsonSchema,
  value: unknown,
  path: string,
  errors: string[],
): void {
  if (schema.oneOf) {
    const matching = schema.oneOf.filter((candidate) => {
      const candidateErrors: string[] = [];
      validateNode(candidate, value, path, candidateErrors);
      return candidateErrors.length === 0;
    });
    if (matching.length !== 1) {
      errors.push(`${path} must match exactly one allowed schema`);
    }
    return;
  }

  if (schema.anyOf) {
    const matches = schema.anyOf.some((candidate) => {
      const candidateErrors: string[] = [];
      validateNode(candidate, value, path, candidateErrors);
      return candidateErrors.length === 0;
    });
    if (!matches) errors.push(`${path} must match an allowed schema`);
    return;
  }

  if (schema.type && !matchesType(value, schema.type)) {
    const expected = Array.isArray(schema.type)
      ? schema.type.join(" or ")
      : schema.type;
    errors.push(`${path} must be ${expected}`);
    return;
  }

  if (schema.const !== undefined && !jsonEquals(value as JsonValue, schema.const)) {
    errors.push(`${path} must equal ${JSON.stringify(schema.const)}`);
  }

  if (
    schema.enum &&
    !schema.enum.some((candidate) => jsonEquals(value as JsonValue, candidate))
  ) {
    errors.push(`${path} must be one of ${schema.enum.map(String).join(", ")}`);
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path} must contain at least ${schema.minLength} characters`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${path} must contain at most ${schema.maxLength} characters`);
    }
    if (schema.pattern !== undefined) {
      try {
        if (!new RegExp(schema.pattern).test(value)) {
          errors.push(`${path} must match ${schema.pattern}`);
        }
      } catch {
        errors.push(`${path} has an invalid schema pattern`);
      }
    }
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${path} must be at least ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${path} must be at most ${schema.maximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${path} must contain at least ${schema.minItems} items`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${path} must contain at most ${schema.maxItems} items`);
    }
    if (schema.items) {
      value.forEach((item, index) =>
        validateNode(schema.items!, item, `${path}[${index}]`, errors),
      );
    }
  }

  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const required of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(record, required)) {
        errors.push(`${path}.${required} is required`);
      }
    }

    const properties = schema.properties ?? {};
    for (const [key, child] of Object.entries(properties)) {
      if (Object.prototype.hasOwnProperty.call(record, key)) {
        validateNode(child, record[key], `${path}.${key}`, errors);
      }
    }

    for (const key of Object.keys(record)) {
      if (key in properties) continue;
      if (schema.additionalProperties === false) {
        errors.push(`${path}.${key} is not allowed`);
      } else if (typeof schema.additionalProperties === "object") {
        validateNode(
          schema.additionalProperties,
          record[key],
          `${path}.${key}`,
          errors,
        );
      }
    }
  }
}

export function validateSchema(
  schema: JsonSchema,
  value: unknown,
): SchemaValidationResult {
  const errors: string[] = [];
  validateNode(schema, value, "$", errors);
  return { valid: errors.length === 0, errors };
}

export function assertSchema(schema: JsonSchema, value: unknown): void {
  const result = validateSchema(schema, value);
  if (!result.valid) {
    throw new TypeError(result.errors.join("; "));
  }
}
