import type { ActionCommand } from "@sotto/core";
import { describe, expect, it, vi } from "vitest";

import {
  COMMAND_ALIASES_KEY,
  CommandAliasError,
  CommandAliasStore,
  MAX_COMMAND_ALIASES,
  normalizeAliasPhrase,
  normalizeCommandAliases,
  validateAliasPhrase,
  type CommandAliasStorage,
} from "../src/command-aliases.js";

function validateCommand(value: unknown): ActionCommand {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("action" in value) ||
    value.action !== "tabs"
  ) {
    throw new TypeError("Invalid command");
  }
  return value as ActionCommand;
}

function createStorage(value: unknown = undefined): {
  storage: CommandAliasStorage;
  values: Record<string, unknown>;
} {
  const values: Record<string, unknown> = {
    [COMMAND_ALIASES_KEY]: value,
  };
  return {
    values,
    storage: {
      get: async (key) => ({ [key]: values[key] }),
      set: async (next) => {
        Object.assign(values, next);
      },
    },
  };
}

function expectAliasError(
  operation: () => unknown,
  code: CommandAliasError["code"],
): void {
  try {
    operation();
    throw new Error("Expected an alias error");
  } catch (error) {
    expect(error).toBeInstanceOf(CommandAliasError);
    expect((error as CommandAliasError).code).toBe(code);
  }
}

describe("command alias phrases", () => {
  it("normalizes case, spaces, and trailing Unicode punctuation", () => {
    expect(normalizeAliasPhrase("  OPEN\u2003TAB？！ ")).toBe("open tab");
    expect(validateAliasPhrase(" Open   Tab... ")).toBe("open tab");
  });

  it.each(["a", "", "a".repeat(51)])(
    "rejects an invalid length for %j",
    (phrase) => {
      expectAliasError(() => validateAliasPhrase(phrase), "length");
    },
  );

  it.each([
    "Hey Jarvis!",
    "yes",
    "Yes, please.",
    "okay",
    "stop dictation",
    "Please end dictation now.",
  ])("rejects the reserved phrase %j", (phrase) => {
    expectAliasError(() => validateAliasPhrase(phrase), "collision");
  });
});

describe("command alias normalization", () => {
  it("drops invalid, duplicate, and extra-key records", () => {
    const result = normalizeCommandAliases(
      [
        { phrase: "New tab", command: { action: "tabs", operation: "new" } },
        { phrase: " new   tab. ", command: { action: "tabs" } },
        { phrase: "invalid", command: { action: "notes" } },
        { phrase: "extra", command: { action: "tabs" }, extra: true },
      ],
      validateCommand,
    );

    expect(result).toEqual({
      aliases: [
        {
          phrase: "new tab",
          command: { action: "tabs", operation: "new" },
        },
      ],
      droppedAliasCount: 3,
    });
  });

  it("handles values that are not arrays", () => {
    expect(normalizeCommandAliases(undefined, validateCommand)).toEqual({
      aliases: [],
      droppedAliasCount: 0,
    });
    expect(normalizeCommandAliases({}, validateCommand)).toEqual({
      aliases: [],
      droppedAliasCount: 1,
    });
  });

  it("retains the first 50 valid aliases", () => {
    const input = Array.from(
      { length: MAX_COMMAND_ALIASES + 2 },
      (_, index) => ({
        phrase: `alias ${index}`,
        command: { action: "tabs", index },
      }),
    );

    const result = normalizeCommandAliases(input, validateCommand);

    expect(result.aliases).toHaveLength(MAX_COMMAND_ALIASES);
    expect(result.aliases.at(-1)?.phrase).toBe("alias 49");
    expect(result.droppedAliasCount).toBe(2);
  });
});

describe("command alias store", () => {
  it("resolves only an exact normalized match and revalidates it", async () => {
    const { storage } = createStorage([
      {
        phrase: "new tab",
        command: { action: "tabs", operation: "new" },
      },
    ]);
    const validator = vi.fn(validateCommand);
    const store = new CommandAliasStore(storage, validator);

    await expect(store.resolve("  NEW   TAB?! ")).resolves.toEqual({
      action: "tabs",
      operation: "new",
    });
    await expect(store.resolve("new tabs")).resolves.toBeUndefined();
    expect(validator).toHaveBeenCalledTimes(2);
  });

  it("does not return a command that fails current validation", async () => {
    const { storage } = createStorage([
      { phrase: "old alias", command: { action: "removed" } },
    ]);
    const store = new CommandAliasStore(storage, validateCommand);

    await expect(store.resolve("old alias")).resolves.toBeUndefined();
    await expect(store.list()).resolves.toEqual([]);
  });

  it("adds, normalizes, and removes an alias", async () => {
    const { storage, values } = createStorage([]);
    const store = new CommandAliasStore(storage, validateCommand);

    await expect(
      store.add("  NEW   TAB. ", {
        action: "tabs",
        operation: "new",
      }),
    ).resolves.toEqual([
      {
        phrase: "new tab",
        command: { action: "tabs", operation: "new" },
      },
    ]);
    expect(values[COMMAND_ALIASES_KEY]).toEqual([
      {
        phrase: "new tab",
        command: { action: "tabs", operation: "new" },
      },
    ]);
    await expect(store.remove("NEW TAB!")).resolves.toEqual([]);
    expect(values[COMMAND_ALIASES_KEY]).toEqual([]);
  });

  it("rejects a duplicate", async () => {
    const { storage } = createStorage([
      { phrase: "new tab", command: { action: "tabs" } },
    ]);
    const store = new CommandAliasStore(storage, validateCommand);

    await expect(
      store.add(" NEW TAB.", { action: "tabs" }),
    ).rejects.toMatchObject({ code: "duplicate" });
  });

  it("rejects an invalid new command", async () => {
    const { storage } = createStorage([]);
    const store = new CommandAliasStore(storage, validateCommand);

    await expect(
      store.add("old command", { action: "removed" }),
    ).rejects.toThrow("Invalid command");
  });

  it("enforces the 50 alias cap", async () => {
    const aliases = Array.from(
      { length: MAX_COMMAND_ALIASES },
      (_, index) => ({
        phrase: `alias ${index}`,
        command: { action: "tabs" },
      }),
    );
    const { storage } = createStorage(aliases);
    const store = new CommandAliasStore(storage, validateCommand);

    await expect(
      store.add("one more", { action: "tabs" }),
    ).rejects.toMatchObject({ code: "limit" });
  });
});
