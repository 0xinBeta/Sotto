export type ActivationMode = "push-to-talk" | "toggle";

export interface SottoSettings {
  readonly activationMode: ActivationMode;
  readonly language: "en-US";
  readonly speakResponses: boolean;
}

export const DEFAULT_SETTINGS: SottoSettings = Object.freeze({
  activationMode: "push-to-talk",
  language: "en-US",
  speakResponses: true,
});

export const SETTINGS_STORAGE_KEY = "settings";

export interface SettingsStorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export function normalizeSettings(value: unknown): SottoSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ...DEFAULT_SETTINGS };
  }
  const candidate = value as Partial<Record<keyof SottoSettings, unknown>>;
  return {
    activationMode:
      candidate.activationMode === "toggle" ? "toggle" : "push-to-talk",
    language: "en-US",
    speakResponses:
      typeof candidate.speakResponses === "boolean"
        ? candidate.speakResponses
        : DEFAULT_SETTINGS.speakResponses,
  };
}

export async function loadSettings(
  storage: SettingsStorageArea,
): Promise<SottoSettings> {
  const stored = await storage.get(SETTINGS_STORAGE_KEY);
  return normalizeSettings(stored[SETTINGS_STORAGE_KEY]);
}

export async function saveSettings(
  storage: SettingsStorageArea,
  settings: SottoSettings,
): Promise<void> {
  await storage.set({
    [SETTINGS_STORAGE_KEY]: normalizeSettings(settings),
  });
}
