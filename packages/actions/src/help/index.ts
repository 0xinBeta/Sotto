import { defineAction } from "@sotto/core";
import type {
  ActionCatalog,
  ActionCommand,
  JsonSchema,
} from "@sotto/core";

export type HelpMode = "show" | "read";

export interface HelpCommand extends ActionCommand {
  readonly action: "help";
  readonly mode: HelpMode;
}

export const HELP_SUMMARY_MAX_CHARACTERS = 96;

export const helpSchema = {
  type: "object",
  properties: {
    action: { const: "help" },
    mode: { type: "string", enum: ["show", "read"] },
  },
  required: ["action", "mode"],
  additionalProperties: false,
} as const satisfies JsonSchema;

function requireActionCatalog(
  catalog: ActionCatalog | undefined,
): ActionCatalog {
  if (!catalog) {
    throw new Error("Help requires the action registry");
  }
  return catalog;
}

export function createHelpSummary(commandCount: number): string {
  const commandLabel = commandCount === 1 ? "command" : "commands";
  return `Sotto supports ${commandCount} ${commandLabel}; open the panel for the list.`;
}

export function createCommandReading(catalog: ActionCatalog): string {
  return catalog
    .list()
    .map((action) => {
      const examples = action.examples
        .map((example) => example.say.replace(/[.!?]+$/u, ""))
        .join("; ");
      return examples ? `${action.title}: ${examples}.` : `${action.title}.`;
    })
    .join(" ");
}

const helpAction = defineAction<HelpCommand>({
  id: "help",
  title: "Help",
  permissions: [],
  schema: helpSchema,
  examples: [
    {
      say: "what can I say",
      emit: { action: "help", mode: "show" },
    },
    {
      say: "help",
      emit: { action: "help", mode: "show" },
    },
    {
      say: "show commands",
      emit: { action: "help", mode: "show" },
    },
    {
      say: "read the commands",
      emit: { action: "help", mode: "read" },
    },
  ],
  confirm: false,
  async execute(command, context) {
    const catalog = requireActionCatalog(context.actionCatalog);
    const spoken =
      command.mode === "read"
        ? createCommandReading(catalog)
        : createHelpSummary(catalog.list().length);
    return {
      spoken,
      workflow: { kind: "panel-command-reference" },
    };
  },
});

export default helpAction;
