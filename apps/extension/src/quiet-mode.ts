export const QUIET_MODE_KEY = "quietMode";

export interface QuietModeStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
}

export function normalizeQuietMode(
  stored: Record<string, unknown>,
): boolean {
  return stored[QUIET_MODE_KEY] === true;
}

export class QuietModeStore {
  readonly #storage: QuietModeStorage;
  #enabled = false;
  #ready: Promise<void> | undefined;
  #updateTail: Promise<unknown> = Promise.resolve();

  constructor(storage: QuietModeStorage) {
    this.#storage = storage;
  }

  async get(): Promise<boolean> {
    await this.#ensureReady();
    await this.#updateTail.catch(() => undefined);
    return this.#enabled;
  }

  update(enabled: boolean): Promise<boolean> {
    const pending = this.#updateTail
      .catch(() => undefined)
      .then(async () => {
        await this.#ensureReady();
        this.#enabled = enabled;
        await this.#storage.set({ [QUIET_MODE_KEY]: enabled });
        return this.#enabled;
      });
    this.#updateTail = pending;
    return pending;
  }

  async #ensureReady(): Promise<void> {
    this.#ready ??= this.#load();
    await this.#ready;
  }

  async #load(): Promise<void> {
    try {
      this.#enabled = normalizeQuietMode(
        await this.#storage.get(QUIET_MODE_KEY),
      );
    } catch (error) {
      this.#enabled = false;
      console.warn(
        "Unable to read quiet mode; using sound",
        error,
      );
    }
  }
}
