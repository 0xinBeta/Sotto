import { describe, expect, it, vi } from "vitest";

import {
  MAX_NOTE_BODY_LENGTH,
  MAX_NOTES,
  NOTES_SCHEMA_VERSION,
  type NoteRecord,
} from "@sotto/actions/notes/storage";
import type { ActionCommand } from "@sotto/core";

import {
  createSettingsBackup,
  createSettingsBackupExport,
  MAX_SETTINGS_BACKUP_NOTE_ITEMS,
  parseSettingsBackup,
  SettingsBackupStore,
  type SettingsBackupStorage,
} from "../src/settings-backup.js";
import {
  COMMAND_ALIASES_KEY,
  MAX_COMMAND_ALIASES,
  type CommandAlias,
  type CommandAliasValidator,
} from "../src/command-aliases.js";

const CREATED_AT = "2026-07-29T10:00:00.000Z";

function note(
  id: string,
  body = `Body ${id}`,
  createdAt = CREATED_AT,
): NoteRecord {
  return {
    id,
    body,
    createdAt,
    updatedAt: createdAt,
  };
}

const validateAliasCommand: CommandAliasValidator = (
  value: unknown,
): ActionCommand => {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (value as { action?: unknown }).action !== "test"
  ) {
    throw new TypeError("The command is invalid");
  }
  return value as ActionCommand;
};

function validBackup(
  notes: readonly NoteRecord[] = [note("one")],
  aliases: readonly CommandAlias[] = [],
) {
  return {
    schemaVersion: 1,
    settings: {
      rate: 1.2,
      volume: 0.8,
      verbosity: "brief",
      doNotDisturb: true,
      wakeWordEnabled: true,
      liveTranscriptPreview: false,
      blockedHostnames: ["example.com", "private.example"],
      premiumTts: {
        enabled: true,
        voice: "af_heart",
      },
      premiumStt: {
        enabled: false,
        tier: "parakeet",
      },
    },
    notes,
    aliases,
  };
}

function changedBackup(
  change: (backup: ReturnType<typeof validBackup>) => void,
): string {
  const backup = structuredClone(validBackup());
  change(backup);
  return JSON.stringify(backup);
}

class MemoryStorage implements SettingsBackupStorage {
  readonly set = vi.fn(async (updates: Record<string, unknown>) => {
    Object.assign(this.values, updates);
  });

  constructor(readonly values: Record<string, unknown> = {}) {}

  async get(): Promise<Record<string, unknown>> {
    return { ...this.values };
  }
}

function decodeBackupDataUrl(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) throw new Error("Missing data URL separator");
  return decodeURIComponent(dataUrl.slice(comma + 1));
}

describe("settings and notes backup", () => {
  it("round-trips settings and notes to identical backup state", async () => {
    const firstNote = {
      ...note("first", "First note", "2026-07-28T10:00:00.000Z"),
      source: {
        title: "Source title",
        url: "https://example.test/note",
      },
    };
    const source = new MemoryStorage({
      schemaVersion: NOTES_SCHEMA_VERSION,
      speechRate: 1.4,
      speechVolume: 0.65,
      responseVerbosity: "brief",
      quietMode: true,
      premiumTtsEnabled: true,
      premiumTtsVoice: "bf_emma",
      premiumSttEnabled: false,
      premiumSttTier: "parakeet",
      wakeWordEnabled: true,
      liveTranscriptPreview: false,
      blockedHostnames: ["example.com", "private.example"],
      [COMMAND_ALIASES_KEY]: [
        {
          phrase: "Open docs.",
          command: { action: "test", target: "docs" },
        },
      ],
      "note:first": firstNote,
      "note:second": note("second", "Second note"),
    });
    const exported = await new SettingsBackupStore(
      source,
      validateAliasCommand,
      () => new Date("2026-07-29T12:00:00.000Z"),
    ).export();
    const target = new MemoryStorage();
    const result = await new SettingsBackupStore(
      target,
      validateAliasCommand,
    ).import(decodeBackupDataUrl(exported.dataUrl));

    expect(exported.filename).toBe("sotto-backup-2026-07-29.json");
    expect(result).toMatchObject({
      noteCount: 2,
      addedNoteCount: 2,
      aliasCount: 1,
      droppedAliasCount: 0,
    });
    expect(createSettingsBackup(target.values, validateAliasCommand)).toEqual(
      createSettingsBackup(source.values, validateAliasCommand),
    );
    expect(target.values[COMMAND_ALIASES_KEY]).toEqual([
      {
        phrase: "open docs",
        command: { action: "test", target: "docs" },
      },
    ]);
    expect(target.set).toHaveBeenCalledOnce();
  });

  it("exports only allowlisted settings and notes", () => {
    const values = {
      schemaVersion: NOTES_SCHEMA_VERSION,
      speechRate: 1,
      speechVolume: 1,
      responseVerbosity: "normal",
      quietMode: false,
      premiumTtsEnabled: false,
      premiumTtsVoice: "af_heart",
      premiumSttEnabled: false,
      premiumSttTier: "moonshine-base",
      wakeWordEnabled: true,
      liveTranscriptPreview: false,
      blockedHostnames: ["example.com", "private.example"],
      premiumTtsDownloaded: true,
      premiumSttDownloaded: true,
      premiumSttDownloadedTiers: { parakeet: true },
      transcripts: ["FORBIDDEN TRANSCRIPT"],
      history: ["FORBIDDEN HISTORY"],
      permissions: { microphone: "granted" },
      modelCaches: ["cached-model"],
      "reminder:later": {
        id: "later",
        text: "FORBIDDEN REMINDER",
      },
      "note:allowed": note("allowed", "Allowed note"),
    };
    const result = createSettingsBackupExport(
      values,
      validateAliasCommand,
      new Date("2026-07-29T12:00:00.000Z"),
    );
    const json = decodeBackupDataUrl(result.dataUrl);

    expect(json).toContain("Allowed note");
    for (const forbidden of [
      "premiumTtsDownloaded",
      "premiumSttDownloaded",
      "premiumSttDownloadedTiers",
      "transcripts",
      "FORBIDDEN TRANSCRIPT",
      "FORBIDDEN HISTORY",
      "FORBIDDEN REMINDER",
      "permissions",
      "modelCaches",
    ]) {
      expect(json).not.toContain(forbidden);
    }
    expect(json).toContain("example.com");
    expect(json).toContain("private.example");
  });

  it("uses safe defaults for backups made before the new settings", () => {
    const backup = validBackup();
    delete (backup.settings as any).wakeWordEnabled;
    delete (backup.settings as any).liveTranscriptPreview;
    delete (backup.settings as any).blockedHostnames;

    expect(parseSettingsBackup(JSON.stringify(backup)).settings)
      .toMatchObject({
        wakeWordEnabled: false,
        liveTranscriptPreview: true,
        blockedHostnames: [],
      });
  });

  it("imports an old backup without aliases", async () => {
    const backup = validBackup();
    delete (backup as { aliases?: readonly CommandAlias[] }).aliases;
    const storage = new MemoryStorage({
      [COMMAND_ALIASES_KEY]: [
        { phrase: "old alias", command: { action: "test" } },
      ],
    });

    const result = await new SettingsBackupStore(
      storage,
      validateAliasCommand,
    ).import(JSON.stringify(backup));

    expect(result.aliasCount).toBe(0);
    expect(result.droppedAliasCount).toBe(0);
    expect(storage.values[COMMAND_ALIASES_KEY]).toEqual([]);
  });

  it.each([
    ["root field", (backup: any) => {
      backup.unknown = true;
    }],
    ["settings field", (backup: any) => {
      backup.settings.unknown = true;
    }],
    ["premium voice field", (backup: any) => {
      backup.settings.premiumTts.unknown = true;
    }],
    ["note field", (backup: any) => {
      backup.notes[0].unknown = true;
    }],
    ["source field", (backup: any) => {
      backup.notes[0].source = {
        title: "Title",
        url: "https://example.test",
        unknown: true,
      };
    }],
    ["alias field", (backup: any) => {
      backup.aliases = [
        {
          phrase: "open docs",
          command: { action: "test" },
          unknown: true,
        },
      ];
    }],
  ])("rejects an unknown %s", (_label, change) => {
    expect(() => parseSettingsBackup(changedBackup(change))).toThrow(
      "Backup data is invalid",
    );
  });

  it.each([
    ["schema version", (backup: any) => {
      backup.schemaVersion = "1";
    }],
    ["rate", (backup: any) => {
      backup.settings.rate = "fast";
    }],
    ["volume", (backup: any) => {
      backup.settings.volume = null;
    }],
    ["verbosity", (backup: any) => {
      backup.settings.verbosity = "long";
    }],
    ["do not disturb", (backup: any) => {
      backup.settings.doNotDisturb = "yes";
    }],
    ["wake phrase", (backup: any) => {
      backup.settings.wakeWordEnabled = "yes";
    }],
    ["live transcript preview", (backup: any) => {
      backup.settings.liveTranscriptPreview = 1;
    }],
    ["blocked site names", (backup: any) => {
      backup.settings.blockedHostnames = [1];
    }],
    ["premium voice enabled", (backup: any) => {
      backup.settings.premiumTts.enabled = 1;
    }],
    ["premium voice", (backup: any) => {
      backup.settings.premiumTts.voice = "unknown";
    }],
    ["premium speech enabled", (backup: any) => {
      backup.settings.premiumStt.enabled = 0;
    }],
    ["premium speech tier", (backup: any) => {
      backup.settings.premiumStt.tier = "unknown";
    }],
    ["notes", (backup: any) => {
      backup.notes = {};
    }],
    ["note id", (backup: any) => {
      backup.notes[0].id = 1;
    }],
    ["note body", (backup: any) => {
      backup.notes[0].body = false;
    }],
    ["note creation date", (backup: any) => {
      backup.notes[0].createdAt = "not-a-date";
    }],
    ["note update date", (backup: any) => {
      backup.notes[0].updatedAt = 1;
    }],
    ["source title", (backup: any) => {
      backup.notes[0].source = {
        title: 1,
        url: "https://example.test",
      };
    }],
    ["source URL", (backup: any) => {
      backup.notes[0].source = {
        title: "Title",
        url: false,
      };
    }],
    ["alias phrase", (backup: any) => {
      backup.aliases = [
        { phrase: 1, command: { action: "test" } },
      ];
    }],
    ["alias command", (backup: any) => {
      backup.aliases = [
        { phrase: "open docs", command: { value: "docs" } },
      ];
    }],
  ])("rejects a bad %s type or value", (_label, change) => {
    expect(() => parseSettingsBackup(changedBackup(change))).toThrow(
      "Backup data is invalid",
    );
  });

  it("rejects oversized note data and oversized note arrays", () => {
    const longBody = changedBackup((backup) => {
      backup.notes[0] = note(
        "long",
        "x".repeat(MAX_NOTE_BODY_LENGTH + 1),
      );
    });
    const tooManyNotes = validBackup(
      Array.from(
        { length: MAX_SETTINGS_BACKUP_NOTE_ITEMS + 1 },
        (_, index) => note(`note-${index}`),
      ),
    );

    expect(() => parseSettingsBackup(longBody)).toThrow(
      "Backup data is invalid",
    );
    expect(() =>
      parseSettingsBackup(JSON.stringify(tooManyNotes))
    ).toThrow("Backup data is invalid");
  });

  it("clamps settings and caps imported notes", async () => {
    const importedNotes = Array.from(
      { length: MAX_NOTES + 1 },
      (_, index) => note(`note-${index}`),
    );
    const backup = validBackup(importedNotes);
    backup.settings.rate = -100;
    backup.settings.volume = 100;
    const storage = new MemoryStorage();
    const result = await new SettingsBackupStore(
      storage,
      validateAliasCommand,
    ).import(JSON.stringify(backup));

    expect(result.settings.rate).toBe(0.5);
    expect(result.settings.volume).toBe(1);
    expect(result.noteCount).toBe(MAX_NOTES);
    expect(result.addedNoteCount).toBe(MAX_NOTES);
    expect(
      Object.keys(storage.values).filter((key) => key.startsWith("note:")),
    ).toHaveLength(MAX_NOTES);
  });

  it("merges notes and deduplicates by id or content before the cap", async () => {
    const existing = Array.from(
      { length: MAX_NOTES - 1 },
      (_, index) => note(`existing-${index}`, `Existing ${index}`),
    );
    const values: Record<string, unknown> = {
      schemaVersion: NOTES_SCHEMA_VERSION,
    };
    for (const item of existing) values[`note:${item.id}`] = item;
    const storage = new MemoryStorage(values);
    const imported = [
      note("existing-0", "New content with an old id"),
      note("new-same-body", "Existing 1"),
      note("new-one", "New one"),
      note("new-two", "New two"),
    ];
    const result = await new SettingsBackupStore(
      storage,
      validateAliasCommand,
    ).import(JSON.stringify(validBackup(imported)));

    expect(result.addedNoteCount).toBe(1);
    expect(storage.values["note:new-one"]).toEqual(imported[2]);
    expect(storage.values["note:new-two"]).toBeUndefined();
    expect(storage.values["note:new-same-body"]).toBeUndefined();
  });

  it("does not write any data after validation fails", async () => {
    const storage = new MemoryStorage({
      speechRate: 1.8,
      "note:safe": note("safe", "Safe note"),
    });
    const before = structuredClone(storage.values);
    const store = new SettingsBackupStore(storage, validateAliasCommand);
    const invalid = changedBackup((backup) => {
      backup.notes[0].body = "x".repeat(MAX_NOTE_BODY_LENGTH + 1);
    });

    await expect(store.import(invalid)).rejects.toThrow(
      "Backup data is invalid",
    );
    expect(storage.values).toEqual(before);
    expect(storage.set).not.toHaveBeenCalled();
  });

  it("previews without a write and applies in one storage call", async () => {
    const storage = new MemoryStorage();
    const store = new SettingsBackupStore(storage, validateAliasCommand);
    const text = JSON.stringify(validBackup([
      note("one"),
      note("two"),
    ]));

    await expect(store.previewImport(text)).resolves.toEqual({
      noteCount: 2,
      aliasCount: 0,
      droppedAliasCount: 0,
    });
    expect(storage.set).not.toHaveBeenCalled();

    await store.import(text);
    expect(storage.set).toHaveBeenCalledOnce();
    const update = storage.set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(update).toMatchObject({
      speechRate: 1.2,
      speechVolume: 0.8,
      responseVerbosity: "brief",
      quietMode: true,
      wakeWordEnabled: true,
      liveTranscriptPreview: false,
      blockedHostnames: ["example.com", "private.example"],
      premiumTtsEnabled: true,
      premiumTtsVoice: "af_heart",
      premiumSttEnabled: false,
      premiumSttTier: "parakeet",
      schemaVersion: NOTES_SCHEMA_VERSION,
      "note:one": note("one"),
      "note:two": note("two"),
      [COMMAND_ALIASES_KEY]: [],
    });
  });

  it("drops commands that fail the current registry validation", async () => {
    const aliases = [
      {
        phrase: "valid alias",
        command: { action: "test", target: "saved" },
      },
      {
        phrase: "removed command",
        command: { action: "removed" },
      },
    ];
    const storage = new MemoryStorage();
    const store = new SettingsBackupStore(storage, validateAliasCommand);
    const text = JSON.stringify(validBackup([], aliases));

    await expect(store.previewImport(text)).resolves.toMatchObject({
      aliasCount: 1,
      droppedAliasCount: 1,
    });
    const result = await store.import(text);

    expect(result.aliasCount).toBe(1);
    expect(result.droppedAliasCount).toBe(1);
    expect(storage.values[COMMAND_ALIASES_KEY]).toEqual([aliases[0]]);
  });

  it("drops reserved and duplicate normalized alias phrases", async () => {
    const aliases = [
      { phrase: "YES", command: { action: "test" } },
      {
        phrase: "  Open   docs. ",
        command: { action: "test", target: "first" },
      },
      {
        phrase: "open docs",
        command: { action: "test", target: "second" },
      },
    ];
    const storage = new MemoryStorage();
    const result = await new SettingsBackupStore(
      storage,
      validateAliasCommand,
    ).import(JSON.stringify(validBackup([], aliases)));

    expect(result.aliasCount).toBe(1);
    expect(result.droppedAliasCount).toBe(2);
    expect(storage.values[COMMAND_ALIASES_KEY]).toEqual([
      {
        phrase: "open docs",
        command: { action: "test", target: "first" },
      },
    ]);
  });

  it("caps imported aliases at the storage limit", async () => {
    const aliases = Array.from(
      { length: MAX_COMMAND_ALIASES + 2 },
      (_, index) => ({
        phrase: `alias ${index}`,
        command: { action: "test", index },
      }),
    );
    const storage = new MemoryStorage();
    const result = await new SettingsBackupStore(
      storage,
      validateAliasCommand,
    ).import(JSON.stringify(validBackup([], aliases)));

    expect(result.aliasCount).toBe(MAX_COMMAND_ALIASES);
    expect(result.droppedAliasCount).toBe(2);
    expect(storage.values[COMMAND_ALIASES_KEY]).toHaveLength(
      MAX_COMMAND_ALIASES,
    );
    expect(storage.set).toHaveBeenCalledOnce();
  });
});
