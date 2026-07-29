import {
  isNoteRecord,
  MAX_NOTE_BODY_LENGTH,
  MAX_NOTES,
  NOTES_SCHEMA_VERSION,
  NOTES_SCHEMA_VERSION_KEY,
  NOTE_KEY_PREFIX,
  type NoteRecord,
} from "@sotto/actions/notes/storage";
import {
  validateSchema,
  type JsonSchema,
} from "@sotto/core";
import {
  isKokoroVoiceId,
  KOKORO_VOICE,
  KOKORO_VOICES,
  type KokoroVoiceId,
} from "@sotto/tts/kokoro-voices";

import {
  PREMIUM_STT_ENABLED_KEY,
  PREMIUM_STT_TIER_KEY,
  type PremiumSttTier,
} from "./premium-stt.js";
import {
  PREMIUM_TTS_ENABLED_KEY,
  PREMIUM_TTS_VOICE_KEY,
} from "./premium-tts.js";
import {
  normalizeQuietMode,
  QUIET_MODE_KEY,
} from "./quiet-mode.js";
import {
  normalizeSpeechSettings,
  RESPONSE_VERBOSITY_KEY,
  SPEECH_RATE_KEY,
  SPEECH_VOLUME_KEY,
  type ResponseVerbosity,
} from "./speech-settings.js";

export const SETTINGS_BACKUP_SCHEMA_VERSION = 1;
export const MAX_SETTINGS_BACKUP_BYTES = 20 * 1024 * 1024;
export const MAX_SETTINGS_BACKUP_NOTE_ITEMS = 5_000;

const NOTE_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$";
const ISO_DATE_MAX_LENGTH = 35;
const SETTINGS_BACKUP_DATA_URL_PREFIX =
  "data:application/json;charset=utf-8,";

export interface SettingsBackupSettings {
  readonly rate: number;
  readonly volume: number;
  readonly verbosity: ResponseVerbosity;
  readonly doNotDisturb: boolean;
  readonly premiumTts: {
    readonly enabled: boolean;
    readonly voice: KokoroVoiceId;
  };
  readonly premiumStt: {
    readonly enabled: boolean;
    readonly tier: PremiumSttTier;
  };
}

export interface SettingsBackup {
  readonly schemaVersion: typeof SETTINGS_BACKUP_SCHEMA_VERSION;
  readonly settings: SettingsBackupSettings;
  readonly notes: readonly NoteRecord[];
}

export interface SettingsBackupExport {
  readonly filename: string;
  readonly dataUrl: string;
}

export interface SettingsBackupImportPreview {
  readonly noteCount: number;
}

export interface SettingsBackupImportResult {
  readonly noteCount: number;
  readonly addedNoteCount: number;
  readonly settings: SettingsBackupSettings;
}

export interface SettingsBackupStorage {
  get(
    keys?: string | readonly string[] | null,
  ): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
}

interface SettingsBackupImportPlan extends SettingsBackupImportResult {
  readonly values: Record<string, unknown>;
}

const sourceSchema: JsonSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    url: { type: "string" },
  },
  required: ["title", "url"],
  additionalProperties: false,
};

const noteSchema: JsonSchema = {
  type: "object",
  properties: {
    id: {
      type: "string",
      minLength: 1,
      maxLength: 128,
      pattern: NOTE_ID_PATTERN,
    },
    body: {
      type: "string",
      minLength: 1,
      maxLength: MAX_NOTE_BODY_LENGTH,
    },
    createdAt: {
      type: "string",
      minLength: 1,
      maxLength: ISO_DATE_MAX_LENGTH,
    },
    updatedAt: {
      type: "string",
      minLength: 1,
      maxLength: ISO_DATE_MAX_LENGTH,
    },
    source: sourceSchema,
  },
  required: ["id", "body", "createdAt", "updatedAt"],
  additionalProperties: false,
};

export const SETTINGS_BACKUP_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    schemaVersion: { const: SETTINGS_BACKUP_SCHEMA_VERSION },
    settings: {
      type: "object",
      properties: {
        rate: { type: "number" },
        volume: { type: "number" },
        verbosity: { enum: ["normal", "brief"] },
        doNotDisturb: { type: "boolean" },
        premiumTts: {
          type: "object",
          properties: {
            enabled: { type: "boolean" },
            voice: {
              enum: KOKORO_VOICES.map((voice) => voice.id),
            },
          },
          required: ["enabled", "voice"],
          additionalProperties: false,
        },
        premiumStt: {
          type: "object",
          properties: {
            enabled: { type: "boolean" },
            tier: { enum: ["parakeet", "moonshine-base"] },
          },
          required: ["enabled", "tier"],
          additionalProperties: false,
        },
      },
      required: [
        "rate",
        "volume",
        "verbosity",
        "doNotDisturb",
        "premiumTts",
        "premiumStt",
      ],
      additionalProperties: false,
    },
    notes: {
      type: "array",
      items: noteSchema,
      maxItems: MAX_SETTINGS_BACKUP_NOTE_ITEMS,
    },
  },
  required: ["schemaVersion", "settings", "notes"],
  additionalProperties: false,
};

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function wellFormed(value: string): string {
  return value.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu,
    "\uFFFD",
  );
}

function validDate(date: Date): void {
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError("Export date must be valid");
  }
}

function isPremiumSttTier(value: unknown): value is PremiumSttTier {
  return value === "parakeet" || value === "moonshine-base";
}

function backupSettings(
  values: Record<string, unknown>,
): SettingsBackupSettings {
  const speech = normalizeSpeechSettings(values);
  return {
    rate: speech.rate,
    volume: speech.volume,
    verbosity: speech.verbosity,
    doNotDisturb: normalizeQuietMode(values),
    premiumTts: {
      enabled: values[PREMIUM_TTS_ENABLED_KEY] === true,
      voice: isKokoroVoiceId(values[PREMIUM_TTS_VOICE_KEY])
        ? values[PREMIUM_TTS_VOICE_KEY]
        : KOKORO_VOICE,
    },
    premiumStt: {
      enabled: values[PREMIUM_STT_ENABLED_KEY] === true,
      tier: isPremiumSttTier(values[PREMIUM_STT_TIER_KEY])
        ? values[PREMIUM_STT_TIER_KEY]
        : "moonshine-base",
    },
  };
}

function storedNotes(values: Record<string, unknown>): NoteRecord[] {
  const notes = Object.entries(values)
    .filter(([key]) => key.startsWith(NOTE_KEY_PREFIX))
    .map(([key, value]) => {
      if (
        !isNoteRecord(value) ||
        key !== `${NOTE_KEY_PREFIX}${value.id}`
      ) {
        throw new TypeError(`Invalid note record at ${key}`);
      }
      return value;
    });
  if (
    notes.length > 0 &&
    values[NOTES_SCHEMA_VERSION_KEY] !== NOTES_SCHEMA_VERSION
  ) {
    throw new TypeError("The notes schema version is invalid");
  }
  return notes.sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt)
  );
}

export function createSettingsBackup(
  values: Record<string, unknown>,
): SettingsBackup {
  return {
    schemaVersion: SETTINGS_BACKUP_SCHEMA_VERSION,
    settings: backupSettings(values),
    notes: storedNotes(values),
  };
}

export function serializeSettingsBackup(
  backup: SettingsBackup,
): string {
  const validation = validateSchema(SETTINGS_BACKUP_SCHEMA, backup);
  if (
    !validation.valid ||
    !backup.notes.every((note) => isNoteRecord(note))
  ) {
    throw new TypeError("Backup data is invalid");
  }
  const json = wellFormed(JSON.stringify(backup, null, 2));
  if (byteLength(json) > MAX_SETTINGS_BACKUP_BYTES) {
    throw new RangeError("Backup data is too large");
  }
  return json;
}

export function createSettingsBackupExport(
  values: Record<string, unknown>,
  date: Date = new Date(),
): SettingsBackupExport {
  validDate(date);
  const json = serializeSettingsBackup(createSettingsBackup(values));
  return {
    filename: `sotto-backup-${date.toISOString().slice(0, 10)}.json`,
    dataUrl: `${SETTINGS_BACKUP_DATA_URL_PREFIX}${encodeURIComponent(json)}`,
  };
}

export function parseSettingsBackup(text: string): SettingsBackup {
  if (
    typeof text !== "string" ||
    byteLength(text) > MAX_SETTINGS_BACKUP_BYTES
  ) {
    throw new TypeError("Backup data is invalid");
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new TypeError("Backup data is invalid");
  }

  const validation = validateSchema(SETTINGS_BACKUP_SCHEMA, value);
  if (!validation.valid) {
    throw new TypeError("Backup data is invalid");
  }
  const backup = value as SettingsBackup;
  if (!backup.notes.every((note) => isNoteRecord(note))) {
    throw new TypeError("Backup data is invalid");
  }

  const settings = backup.settings;
  const normalizedSettings = backupSettings({
    [SPEECH_RATE_KEY]: settings.rate,
    [SPEECH_VOLUME_KEY]: settings.volume,
    [RESPONSE_VERBOSITY_KEY]: settings.verbosity,
    [QUIET_MODE_KEY]: settings.doNotDisturb,
    [PREMIUM_TTS_ENABLED_KEY]: settings.premiumTts.enabled,
    [PREMIUM_TTS_VOICE_KEY]: settings.premiumTts.voice,
    [PREMIUM_STT_ENABLED_KEY]: settings.premiumStt.enabled,
    [PREMIUM_STT_TIER_KEY]: settings.premiumStt.tier,
  });
  return {
    schemaVersion: SETTINGS_BACKUP_SCHEMA_VERSION,
    settings: normalizedSettings,
    notes: backup.notes,
  };
}

function importPlan(
  text: string,
  stored: Record<string, unknown>,
): SettingsBackupImportPlan {
  const backup = parseSettingsBackup(text);
  const existing = storedNotes(stored);
  const ids = new Set(existing.map((note) => note.id));
  const bodies = new Set(existing.map((note) => note.body));
  const additions: NoteRecord[] = [];
  const available = Math.max(0, MAX_NOTES - existing.length);

  for (const note of backup.notes) {
    if (
      additions.length >= available ||
      ids.has(note.id) ||
      bodies.has(note.body)
    ) {
      continue;
    }
    ids.add(note.id);
    bodies.add(note.body);
    additions.push(note);
  }

  const settings = backup.settings;
  const values: Record<string, unknown> = {
    [SPEECH_RATE_KEY]: settings.rate,
    [SPEECH_VOLUME_KEY]: settings.volume,
    [RESPONSE_VERBOSITY_KEY]: settings.verbosity,
    [QUIET_MODE_KEY]: settings.doNotDisturb,
    [PREMIUM_TTS_ENABLED_KEY]: settings.premiumTts.enabled,
    [PREMIUM_TTS_VOICE_KEY]: settings.premiumTts.voice,
    [PREMIUM_STT_ENABLED_KEY]: settings.premiumStt.enabled,
    [PREMIUM_STT_TIER_KEY]: settings.premiumStt.tier,
    [NOTES_SCHEMA_VERSION_KEY]: NOTES_SCHEMA_VERSION,
  };
  for (const note of additions) {
    values[`${NOTE_KEY_PREFIX}${note.id}`] = note;
  }

  return {
    values,
    noteCount: Math.min(backup.notes.length, MAX_NOTES),
    addedNoteCount: additions.length,
    settings,
  };
}

export class SettingsBackupStore {
  readonly #storage: SettingsBackupStorage;
  readonly #now: () => Date;

  constructor(
    storage: SettingsBackupStorage,
    now: () => Date = () => new Date(),
  ) {
    this.#storage = storage;
    this.#now = now;
  }

  async export(): Promise<SettingsBackupExport> {
    return createSettingsBackupExport(
      await this.#storage.get(null),
      this.#now(),
    );
  }

  async previewImport(
    text: string,
  ): Promise<SettingsBackupImportPreview> {
    const plan = importPlan(text, await this.#storage.get(null));
    return { noteCount: plan.noteCount };
  }

  async import(text: string): Promise<SettingsBackupImportResult> {
    const plan = importPlan(text, await this.#storage.get(null));
    await this.#storage.set(plan.values);
    return {
      noteCount: plan.noteCount,
      addedNoteCount: plan.addedNoteCount,
      settings: plan.settings,
    };
  }
}
