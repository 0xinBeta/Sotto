import { validateSchema } from "./schema.js";
import type {
  ActionCommand,
  ActionContext,
  ActionDefinition,
  ActionExample,
  ActionResult,
  DestinationContext,
  DestinationDefinition,
  DestinationInput,
  JsonSchema,
} from "./types.js";

const UNKNOWN_SCHEMA = {
  type: "object",
  properties: {
    action: { const: "unknown" },
  },
  required: ["action"],
  additionalProperties: false,
} as const satisfies JsonSchema;

export class CommandValidationError extends Error {
  constructor(
    message: string,
    readonly validationErrors: readonly string[] = [],
  ) {
    super(message);
    this.name = "CommandValidationError";
  }
}

export class DuplicatePluginError extends Error {
  constructor(kind: "action" | "destination", id: string) {
    super(`Duplicate ${kind} plugin id: ${id}`);
    this.name = "DuplicatePluginError";
  }
}

export class ActionRegistry {
  readonly #actions = new Map<string, ActionDefinition>();

  constructor(actions: readonly ActionDefinition[] = []) {
    for (const action of actions) this.register(action);
  }

  register(action: ActionDefinition): void {
    if (action.id === "unknown") {
      throw new Error('"unknown" is reserved by the command router');
    }
    if (this.#actions.has(action.id)) {
      throw new DuplicatePluginError("action", action.id);
    }
    this.#actions.set(action.id, action);
  }

  get(actionId: string): ActionDefinition | undefined {
    return this.#actions.get(actionId);
  }

  list(): readonly ActionDefinition[] {
    return [...this.#actions.values()];
  }

  get permissions(): readonly string[] {
    return [...new Set(this.list().flatMap((action) => action.permissions))];
  }

  get examples(): readonly ActionExample[] {
    return this.list().flatMap((action) => action.examples);
  }

  /**
   * A Prompt API-compatible responseConstraint. Each plugin owns its complete
   * command schema, so adding a plugin only requires registration.
   */
  get schema(): JsonSchema {
    return {
      oneOf: [...this.list().map((action) => action.schema), UNKNOWN_SCHEMA],
    };
  }
}

export class DestinationRegistry {
  readonly #destinations = new Map<string, DestinationDefinition>();

  constructor(destinations: readonly DestinationDefinition[] = []) {
    for (const destination of destinations) this.register(destination);
  }

  register(destination: DestinationDefinition): void {
    if (this.#destinations.has(destination.id)) {
      throw new DuplicatePluginError("destination", destination.id);
    }
    this.#destinations.set(destination.id, destination);
  }

  list(): readonly DestinationDefinition[] {
    return [...this.#destinations.values()];
  }

  get permissions(): readonly string[] {
    return [...new Set(this.list().flatMap((destination) => destination.permissions))];
  }

  async dispatch(
    destinationId: string,
    input: DestinationInput,
    context: DestinationContext = {},
  ): Promise<ActionResult> {
    const destination = this.#destinations.get(destinationId);
    if (!destination) {
      throw new Error(`Unknown destination: ${destinationId}`);
    }
    return destination.execute(input, context);
  }
}

export interface CommandRouterOptions {
  readonly unknownSpoken?: string;
}

/**
 * The model's constraint is defense in depth, not a trust boundary. This
 * router parses and validates every command again immediately before execute.
 */
export class CommandRouter {
  readonly #unknownSpoken: string;

  constructor(
    readonly registry: ActionRegistry,
    options: CommandRouterOptions = {},
  ) {
    this.#unknownSpoken =
      options.unknownSpoken ?? "Sorry, say that again?";
  }

  parse(commandJson: string | unknown): ActionCommand {
    let candidate: unknown = commandJson;
    if (typeof commandJson === "string") {
      try {
        candidate = JSON.parse(commandJson);
      } catch {
        throw new CommandValidationError("Command is not valid JSON");
      }
    }

    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate)
    ) {
      throw new CommandValidationError("Command must be a JSON object");
    }

    const actionId = (candidate as { action?: unknown }).action;
    if (typeof actionId !== "string") {
      throw new CommandValidationError("Command action must be a string");
    }

    const validation = validateSchema(this.registry.schema, candidate);

    if (actionId === "unknown") {
      if (!validation.valid) {
        const unknownValidation = validateSchema(UNKNOWN_SCHEMA, candidate);
        throw new CommandValidationError(
          "Invalid unknown command",
          unknownValidation.valid
            ? validation.errors
            : unknownValidation.errors,
        );
      }
      return candidate as ActionCommand;
    }

    const action = this.registry.get(actionId);
    if (!action) {
      throw new CommandValidationError(`Action is not registered: ${actionId}`);
    }

    if (!validation.valid) {
      const actionValidation = validateSchema(action.schema, candidate);
      throw new CommandValidationError(
        `Invalid command for action: ${actionId}`,
        actionValidation.valid ? validation.errors : actionValidation.errors,
      );
    }
    return candidate as ActionCommand;
  }

  async route(
    commandJson: string | unknown,
    context: ActionContext = {},
  ): Promise<ActionResult> {
    const command = this.parse(commandJson);
    if (command.action === "unknown") {
      return { spoken: this.#unknownSpoken };
    }

    const action = this.registry.get(command.action);
    // parse() already proved this exists. Preserve the check at the execution
    // boundary in case a future registry implementation becomes mutable.
    if (!action) {
      throw new CommandValidationError(
        `Action is not registered: ${command.action}`,
      );
    }
    if (action.confirm) {
      throw new CommandValidationError(
        `Action requires confirmation before execution: ${command.action}`,
      );
    }
    return action.execute(command, context);
  }
}

export function createActionRegistry(
  actions: readonly ActionDefinition[],
): ActionRegistry {
  return new ActionRegistry(actions);
}

export function createDestinationRegistry(
  destinations: readonly DestinationDefinition[],
): DestinationRegistry {
  return new DestinationRegistry(destinations);
}
