export const MODEL_IDLE_RELEASE_MS = 3 * 60 * 1_000;

export interface ModelLruOptions {
  readonly idleMs?: number;
  readonly now?: () => number;
  readonly setTimer?: (
    callback: () => void,
    delay: number,
  ) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  readonly onError?: (key: string, error: unknown) => void;
}

interface ModelEntry {
  readonly release: () => Promise<void>;
  lastUsed: number;
  resident: boolean;
  releasing: Promise<boolean> | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export class ModelResidencyLru {
  readonly #entries = new Map<string, ModelEntry>();
  readonly #idleMs: number;
  readonly #now: () => number;
  readonly #setTimer: NonNullable<ModelLruOptions["setTimer"]>;
  readonly #clearTimer: NonNullable<ModelLruOptions["clearTimer"]>;
  readonly #onError: (key: string, error: unknown) => void;
  #underMemoryPressure = false;

  constructor(options: ModelLruOptions = {}) {
    this.#idleMs = options.idleMs ?? MODEL_IDLE_RELEASE_MS;
    this.#now = options.now ?? Date.now;
    this.#setTimer = options.setTimer ?? setTimeout;
    this.#clearTimer = options.clearTimer ?? clearTimeout;
    this.#onError = options.onError ??
      ((key, error) => console.warn(`${key} idle release failed`, error));
  }

  register(key: string, release: () => Promise<void>): void {
    const previous = this.#entries.get(key);
    if (previous?.timer !== undefined) this.#clearTimer(previous.timer);
    this.#entries.set(key, {
      release,
      lastUsed: this.#now(),
      resident: false,
      releasing: undefined,
      timer: undefined,
    });
  }

  markResident(key: string): void {
    const entry = this.#require(key);
    entry.resident = true;
    entry.lastUsed = this.#now();
    this.#schedule(key, entry);
  }

  touch(key: string): void {
    const entry = this.#require(key);
    if (!entry.resident) return;
    entry.lastUsed = this.#now();
    this.#schedule(key, entry);
  }

  markReleased(key: string): void {
    const entry = this.#require(key);
    entry.resident = false;
    if (entry.timer !== undefined) {
      this.#clearTimer(entry.timer);
      entry.timer = undefined;
    }
  }

  noteMemoryPressure(): void {
    this.#underMemoryPressure = true;
    for (const [key, entry] of this.#entries) {
      this.#schedule(key, entry);
    }
  }

  async evictLeastRecentlyUsed(exclude?: string): Promise<string | undefined> {
    this.noteMemoryPressure();
    const candidates = [...this.#entries.entries()]
      .filter(([key, entry]) =>
        key !== exclude && entry.resident && !entry.releasing
      )
      .sort((left, right) => left[1].lastUsed - right[1].lastUsed);
    const candidate = candidates[0];
    if (!candidate) return undefined;
    const [key, entry] = candidate;
    return await this.#release(key, entry) ? key : undefined;
  }

  isResident(key: string): boolean {
    return this.#entries.get(key)?.resident === true;
  }

  dispose(): void {
    for (const entry of this.#entries.values()) {
      if (entry.timer !== undefined) this.#clearTimer(entry.timer);
      entry.timer = undefined;
    }
  }

  #schedule(key: string, entry: ModelEntry): void {
    if (entry.timer !== undefined) {
      this.#clearTimer(entry.timer);
      entry.timer = undefined;
    }
    if (!this.#underMemoryPressure || !entry.resident || entry.releasing) {
      return;
    }
    const remaining = Math.max(0, this.#idleMs - (this.#now() - entry.lastUsed));
    entry.timer = this.#setTimer(() => {
      entry.timer = undefined;
      if (this.#now() - entry.lastUsed < this.#idleMs) {
        this.#schedule(key, entry);
        return;
      }
      void this.#release(key, entry);
    }, remaining);
  }

  async #release(key: string, entry: ModelEntry): Promise<boolean> {
    if (!entry.resident) return false;
    if (entry.releasing) return entry.releasing;
    if (entry.timer !== undefined) {
      this.#clearTimer(entry.timer);
      entry.timer = undefined;
    }
    entry.releasing = entry.release()
      .then(() => {
        entry.resident = false;
        return true;
      })
      .catch((error: unknown) => {
        this.#onError(key, error);
        this.#schedule(key, entry);
        return false;
      })
      .finally(() => {
        entry.releasing = undefined;
      });
    return entry.releasing;
  }

  #require(key: string): ModelEntry {
    const entry = this.#entries.get(key);
    if (!entry) throw new Error(`Unknown resident model: ${key}`);
    return entry;
  }
}
