import { describe, expect, it, vi } from "vitest";

import {
  ActionRegistry,
  CommandRouter,
  CommandValidationError,
  DestinationRegistry,
  DuplicatePluginError,
  createActionRegistry,
  createDestinationRegistry,
  defineAction,
  defineDestination,
  type ActionCommand,
  type ActionContext,
  type ImageDestinationInput,
  type JsonSchema,
} from "../src/index.js";

interface CountCommand extends ActionCommand {
  readonly action: "count";
  readonly amount: number;
}

interface TabsCommand extends ActionCommand {
  readonly action: "tabs";
  readonly operation: "new" | "close";
}

const COUNT_SCHEMA = {
  type: "object",
  properties: {
    action: { const: "count" },
    amount: { type: "integer", minimum: 1 },
  },
  required: ["action", "amount"],
  additionalProperties: false,
} as const satisfies JsonSchema;

const TABS_SCHEMA = {
  type: "object",
  properties: {
    action: { const: "tabs" },
    operation: { enum: ["new", "close"] },
  },
  required: ["action", "operation"],
  additionalProperties: false,
} as const satisfies JsonSchema;

function countAction(
  execute = vi.fn(
    async (command: CountCommand, _context: ActionContext) => ({
      spoken: `Counted ${command.amount}.`,
    }),
  ),
) {
  return defineAction<CountCommand>({
    id: "count",
    title: "Count",
    permissions: ["tabs", "activeTab"],
    schema: COUNT_SCHEMA,
    examples: [
      {
        say: "count one",
        emit: { action: "count", amount: 1 },
      },
    ],
    confirm: false,
    execute,
  });
}

function imageDestination(id = "copy") {
  return defineDestination<ImageDestinationInput>({
    id,
    title: "Copy",
    permissions: ["clipboardWrite"],
    async execute(input) {
      return { spoken: `Copied ${input.mimeType}.` };
    },
  });
}

describe("plugin definition helpers", () => {
  it("preserves the complete action definition shape", () => {
    const action = countAction();

    expect(action).toMatchObject({
      id: "count",
      title: "Count",
      permissions: ["tabs", "activeTab"],
      schema: COUNT_SCHEMA,
      examples: [
        {
          say: "count one",
          emit: { action: "count", amount: 1 },
        },
      ],
      confirm: false,
    });
    expect(action.schema).toBe(COUNT_SCHEMA);
    expect(action.execute).toBeTypeOf("function");
  });

  it("preserves the complete destination definition shape", () => {
    const destination = imageDestination();

    expect(destination).toMatchObject({
      id: "copy",
      title: "Copy",
      permissions: ["clipboardWrite"],
    });
    expect(destination.execute).toBeTypeOf("function");
  });
});

describe("ActionRegistry", () => {
  it("merges schemas, examples, and de-duplicated permissions in registration order", () => {
    const secondSchema = {
      type: "object",
      properties: { action: { const: "second" } },
      required: ["action"],
      additionalProperties: false,
    } as const satisfies JsonSchema;
    const second = defineAction({
      id: "second",
      title: "Second",
      permissions: ["tabs"],
      schema: secondSchema,
      examples: [
        {
          say: "the second action",
          emit: { action: "second" },
        },
      ],
      confirm: true,
      async execute() {
        return { spoken: "Second." };
      },
    });

    const registry = createActionRegistry([countAction(), second]);

    expect(registry.list().map(({ id }) => id)).toEqual(["count", "second"]);
    expect(registry.permissions).toEqual(["tabs", "activeTab"]);
    expect(registry.examples).toEqual([
      { say: "count one", emit: { action: "count", amount: 1 } },
      { say: "the second action", emit: { action: "second" } },
    ]);
    expect(registry.schema.oneOf?.slice(0, 2)).toEqual([
      COUNT_SCHEMA,
      secondSchema,
    ]);
    expect(registry.schema.oneOf?.at(-1)).toEqual({
      type: "object",
      properties: { action: { const: "unknown" } },
      required: ["action"],
      additionalProperties: false,
    });
  });

  it("rejects duplicate and reserved action ids", () => {
    expect(() => new ActionRegistry([countAction(), countAction()])).toThrow(
      DuplicatePluginError,
    );
    expect(() => new ActionRegistry([countAction(), countAction()])).toThrow(
      "Duplicate action plugin id: count",
    );

    expect(() =>
      new ActionRegistry([
        defineAction({
          id: "unknown",
          title: "Reserved",
          permissions: [],
          schema: {},
          examples: [],
          confirm: false,
          async execute() {
            return { spoken: "Never." };
          },
        }),
      ]),
    ).toThrow('"unknown" is reserved by the command router');
  });
});

describe("DestinationRegistry", () => {
  it("merges permissions and dispatches to the selected destination", async () => {
    const copy = imageDestination();
    const claude = defineDestination<ImageDestinationInput>({
      id: "claude",
      title: "Claude",
      permissions: ["clipboardWrite", "tabs"],
      async execute() {
        return { spoken: "Paste-ready." };
      },
    });
    const registry = createDestinationRegistry([copy, claude]);
    const input: ImageDestinationInput = {
      kind: "image",
      mimeType: "image/png",
      dataUrl: "data:image/png;base64,c290dG8=",
    };

    expect(registry.permissions).toEqual(["clipboardWrite", "tabs"]);
    await expect(registry.dispatch("copy", input)).resolves.toEqual({
      spoken: "Copied image/png.",
    });
    await expect(registry.dispatch("missing", input)).rejects.toThrow(
      "Unknown destination: missing",
    );
  });

  it("rejects duplicate destination ids", () => {
    expect(
      () =>
        new DestinationRegistry([
          imageDestination("copy"),
          imageDestination("copy"),
        ]),
    ).toThrow("Duplicate destination plugin id: copy");
  });
});

describe("CommandRouter", () => {
  it("routes a valid command to its registered action with context", async () => {
    const execute = vi.fn(
      async (command: CountCommand, _context: ActionContext) => ({
        spoken: `Counted ${command.amount}.`,
      }),
    );
    const router = new CommandRouter(new ActionRegistry([countAction(execute)]));
    const context: ActionContext = {
      dispatchDestination: vi.fn(),
    };

    await expect(
      router.route('{"action":"count","amount":2}', context),
    ).resolves.toEqual({ spoken: "Counted 2." });
    expect(execute).toHaveBeenCalledWith(
      { action: "count", amount: 2 },
      context,
    );
  });

  it("rejects commands that do not satisfy the plugin schema before execution", async () => {
    const execute = vi.fn(
      async (_command: CountCommand, _context: ActionContext) => ({
        spoken: "Should not run.",
      }),
    );
    const router = new CommandRouter(new ActionRegistry([countAction(execute)]));

    await expect(
      router.route({ action: "count", amount: "two" }),
    ).rejects.toMatchObject({
      name: "CommandValidationError",
      message: "Invalid command for action: count",
      validationErrors: ["$.amount must be integer"],
    } satisfies Partial<CommandValidationError>);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    {
      case: "wrong action id",
      command: { action: "invented", operation: "new" },
      message: "Action is not registered: invented",
    },
    {
      case: "missing required field",
      command: { action: "tabs" },
      message: "Invalid command for action: tabs",
    },
    {
      case: "extra property",
      command: { action: "tabs", operation: "new", injected: true },
      message: "Invalid command for action: tabs",
    },
    {
      case: "invalid enum value",
      command: { action: "tabs", operation: "switch" },
      message: "Invalid command for action: tabs",
    },
  ])("rejects $case without executing the plugin", async ({ command, message }) => {
    const execute = vi.fn(
      async (_command: TabsCommand, _context: ActionContext) => ({
        spoken: "Should not run.",
      }),
    );
    const tabs = defineAction<TabsCommand>({
      id: "tabs",
      title: "Tabs",
      permissions: ["tabs"],
      schema: TABS_SCHEMA,
      examples: [],
      confirm: false,
      execute,
    });
    const router = new CommandRouter(new ActionRegistry([tabs]));

    await expect(router.route(command)).rejects.toMatchObject({
      name: "CommandValidationError",
      message,
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("returns the deterministic retry for an exact unknown command", async () => {
    const router = new CommandRouter(new ActionRegistry(), {
      unknownSpoken: "Please try again.",
    });

    await expect(router.route({ action: "unknown" })).resolves.toEqual({
      spoken: "Please try again.",
    });
    await expect(
      router.route({ action: "unknown", invented: true }),
    ).rejects.toThrow("Invalid unknown command");
  });

  it("fails closed instead of executing an action that requires confirmation", async () => {
    const execute = vi.fn(async () => ({ spoken: "Should not run." }));
    const confirmed = defineAction<CountCommand>({
      ...countAction(execute),
      confirm: true,
    });
    const router = new CommandRouter(new ActionRegistry([confirmed]));

    await expect(
      router.route({ action: "count", amount: 1 }),
    ).rejects.toThrow("Action requires confirmation before execution: count");
    expect(execute).not.toHaveBeenCalled();
  });

  it("revalidates against the merged registry schema at the execution boundary", async () => {
    const execute = vi.fn(async () => ({ spoken: "Should not run." }));
    const count = countAction(execute);
    const overlapping = defineAction({
      id: "second",
      title: "Overlapping",
      permissions: [],
      schema: {
        type: "object",
        properties: {
          action: { enum: ["count", "second"] },
          amount: { type: "integer", minimum: 1 },
        },
        required: ["action", "amount"],
        additionalProperties: false,
      },
      examples: [],
      confirm: false,
      async execute() {
        return { spoken: "Should not run." };
      },
    });
    const router = new CommandRouter(new ActionRegistry([count, overlapping]));

    await expect(
      router.route({ action: "count", amount: 1 }),
    ).rejects.toMatchObject({
      validationErrors: ["$ must match exactly one allowed schema"],
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON and unregistered actions", () => {
    const router = new CommandRouter(new ActionRegistry());

    expect(() => router.parse("{")).toThrow("Command is not valid JSON");
    expect(() => router.parse({ action: "missing" })).toThrow(
      "Action is not registered: missing",
    );
  });
});
