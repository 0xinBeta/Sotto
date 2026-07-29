import type { ActionCommand } from "@sotto/core";

import { isConfirmationPhrase } from "./confirmation.js";
import { isDictationExitPhrase } from "./dictation.js";
import { WAKE_PHRASE } from "./wake-word-settings.js";

export const COMMAND_ALIASES_KEY = "commandAliases";
export const MAX_COMMAND_ALIASES = 50;

export interface CommandAlias {
  readonly phrase: string;
  readonly command: ActionCommand;
}

export type CommandAliasValidator = (value: unknown) => ActionCommand;

export interface CommandAliasStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
}

export type CommandAliasErrorCode =
  | "length"
  | "collision"
  | "duplicate"
  | "limit";

const ERROR_MESSAGES: Readonly<Record<CommandAliasErrorCode, string>> = {
  length: "Use 2 to 50 characters.",
  collision: "This phrase is reserved. Use a different phrase.",
  duplicate: "This alias already exists.",
  limit: "You can save up to 50 aliases.",
};

export class CommandAliasError extends Error {
  constructor(readonly code: CommandAliasErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "CommandAliasError";
  }
}

const TRAILING_PUNCTUATION = /\p{P}+$/gu;
const WAKE_PHRASE_NORMALIZED = normalizeAliasPhrase(WAKE_PHRASE);

export function normalizeAliasPhrase(phrase: string): string {
  return phrase
    .toLocaleLowerCase("en-US")
    .trim()
    .replace(/\s+/gu, " ")
    .replace(TRAILING_PUNCTUATION, "")
    .trim();
}

export function validateAliasPhrase(phrase: string): string {
  const normalized = normalizeAliasPhrase(phrase);
  const length = [...normalized].length;
  if (length < 2 || length > 50) {
    throw new CommandAliasError("length");
  }
  if (
    normalized === WAKE_PHRASE_NORMALIZED ||
    isDictationExitPhrase(normalized) ||
    isConfirmationPhrase(normalized)
  ) {
    throw new CommandAliasError("collision");
  }
  return normalized;
}

function isStrictAliasRecord(
  value: unknown,
): value is { readonly phrase: unknown; readonly command: unknown } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value);
  return (
    keys.length === 2 &&
    keys.includes("phrase") &&
    keys.includes("command")
  );
}

export function normalizeCommandAliases(
  value: unknown,
  validator: CommandAliasValidator,
): { aliases: CommandAlias[]; droppedAliasCount: number } {
  if (!Array.isArray(value)) {
    return {
      aliases: [],
      droppedAliasCount: value === undefined ? 0 : 1,
    };
  }

  const aliases: CommandAlias[] = [];
  const phrases = new Set<string>();
  let droppedAliasCount = 0;

  for (const candidate of value) {
    if (!isStrictAliasRecord(candidate) || typeof candidate.phrase !== "string") {
      droppedAliasCount += 1;
      continue;
    }

    try {
      const phrase = validateAliasPhrase(candidate.phrase);
      if (phrases.has(phrase) || aliases.length >= MAX_COMMAND_ALIASES) {
        droppedAliasCount += 1;
        continue;
      }
      const command = validator(candidate.command);
      aliases.push({ phrase, command });
      phrases.add(phrase);
    } catch {
      droppedAliasCount += 1;
    }
  }

  return { aliases, droppedAliasCount };
}

export class CommandAliasStore {
  constructor(
    readonly storage: CommandAliasStorage,
    readonly validator: CommandAliasValidator,
  ) {}

  async list(): Promise<CommandAlias[]> {
    const values = await this.storage.get(COMMAND_ALIASES_KEY);
    return normalizeCommandAliases(
      values[COMMAND_ALIASES_KEY],
      this.validator,
    ).aliases;
  }

  async resolve(transcript: string): Promise<ActionCommand | undefined> {
    const normalized = normalizeAliasPhrase(transcript);
    const alias = (await this.list()).find(
      (candidate) => candidate.phrase === normalized,
    );
    return alias?.command;
  }

  async add(phrase: string, value: unknown): Promise<CommandAlias[]> {
    const normalized = validateAliasPhrase(phrase);
    const aliases = await this.list();
    if (aliases.some((alias) => alias.phrase === normalized)) {
      throw new CommandAliasError("duplicate");
    }
    if (aliases.length >= MAX_COMMAND_ALIASES) {
      throw new CommandAliasError("limit");
    }
    const command = this.validator(value);
    const next = [...aliases, { phrase: normalized, command }];
    await this.storage.set({ [COMMAND_ALIASES_KEY]: next });
    return next;
  }

  async remove(phrase: string): Promise<CommandAlias[]> {
    const normalized = normalizeAliasPhrase(phrase);
    const aliases = await this.list();
    const next = aliases.filter((alias) => alias.phrase !== normalized);
    if (next.length !== aliases.length) {
      await this.storage.set({ [COMMAND_ALIASES_KEY]: next });
    }
    return next;
  }
}
