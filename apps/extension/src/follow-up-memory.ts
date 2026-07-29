import type { ActionCommand } from "@sotto/core";
import type { ParserMemoryExchange } from "@sotto/nano";

export const FOLLOW_UP_MEMORY_LIMIT = 2;
export const FOLLOW_UP_WINDOW_MS = 30_000;
export const COMPLETED_RESULT_SUMMARY = "Command completed." as const;

const UNKNOWN_COMMAND = Object.freeze({
  action: "unknown",
}) satisfies ActionCommand;

/**
 * Session-only parser context. Completion times stay separate from entries,
 * so prompt memory contains only approved exchange data.
 */
export class FollowUpMemory {
  readonly #entries: ParserMemoryExchange[] = [];
  readonly #completedAt: number[] = [];

  record(
    transcript: string,
    command: ActionCommand,
    completedAt = Date.now(),
  ): void {
    if (command.action === "unknown") return;

    this.#entries.push(Object.freeze({
      transcript,
      command: Object.freeze({ ...command }),
      resultSummary: COMPLETED_RESULT_SUMMARY,
    }));
    this.#completedAt.push(completedAt);

    while (this.#entries.length > FOLLOW_UP_MEMORY_LIMIT) {
      this.#entries.shift();
      this.#completedAt.shift();
    }
  }

  recent(now = Date.now()): readonly ParserMemoryExchange[] {
    const entries: ParserMemoryExchange[] = [];
    const completedAt: number[] = [];

    for (let index = 0; index < this.#entries.length; index += 1) {
      const time = this.#completedAt[index];
      const entry = this.#entries[index];
      if (
        time !== undefined &&
        entry !== undefined &&
        now - time <= FOLLOW_UP_WINDOW_MS
      ) {
        entries.push(entry);
        completedAt.push(time);
      }
    }

    this.#entries.splice(0, this.#entries.length, ...entries);
    this.#completedAt.splice(0, this.#completedAt.length, ...completedAt);
    return Object.freeze([...this.#entries]);
  }

  clear(): void {
    this.#entries.splice(0);
    this.#completedAt.splice(0);
  }
}

function isCorrectedTabSwitch(
  command: ActionCommand,
): command is ActionCommand & {
  readonly action: "tabs";
  readonly operation: "switch";
  readonly target: string;
  readonly correction: true;
} {
  const candidate = command as {
    readonly operation?: unknown;
    readonly target?: unknown;
    readonly correction?: unknown;
  };
  return (
    command.action === "tabs" &&
    candidate.operation === "switch" &&
    typeof candidate.target === "string" &&
    candidate.correction === true
  );
}

function isPriorTabSwitch(
  command: ActionCommand | undefined,
): command is ActionCommand & {
  readonly action: "tabs";
  readonly operation: "switch";
  readonly target: string;
} {
  const candidate = command as {
    readonly operation?: unknown;
    readonly target?: unknown;
  } | undefined;
  return (
    command?.action === "tabs" &&
    candidate?.operation === "switch" &&
    typeof candidate.target === "string"
  );
}

/**
 * Nano only marks a tab correction. The prior validated command supplies the
 * target, so a phrase such as "the other one" cannot become the match target.
 */
export function resolveFollowUpCommand(
  command: ActionCommand,
  memory: readonly ParserMemoryExchange[],
): ActionCommand {
  if (!isCorrectedTabSwitch(command)) return command;

  const prior = memory.at(-1)?.command;
  if (!isPriorTabSwitch(prior)) return UNKNOWN_COMMAND;
  return { ...command, target: prior.target } as typeof command;
}
