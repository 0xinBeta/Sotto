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
  inUse: number;
  releaseRequested: boolean;
  releaseWaiters: Array<(released: boolean) => void>;
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
      inUse: 0,
      releaseRequested: false,
      releaseWaiters: [],
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

  acquire(key: string): () => void {
    const entry = this.#require(key);
    if (entry.releaseRequested || entry.releasing) {
      throw new Error(`Resident model release is in progress: ${key}`);
    }
    if (!entry.resident) return () => undefined;
    entry.inUse += 1;
    entry.lastUsed = this.#now();
    if (entry.timer !== undefined) {
      this.#clearTimer(entry.timer);
      entry.timer = undefined;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      entry.inUse = Math.max(0, entry.inUse - 1);
      entry.lastUsed = this.#now();
      if (entry.inUse === 0 && entry.releaseRequested) {
        void this.#release(key, entry);
        return;
      }
      this.#schedule(key, entry);
    };
  }

  markReleased(key: string): void {
    const entry = this.#require(key);
    entry.resident = false;
    if (!entry.releasing) {
      entry.releaseRequested = false;
      this.#resolveReleaseWaiters(entry, true);
    }
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
        key !== exclude &&
        entry.resident &&
        entry.inUse === 0 &&
        !entry.releasing
      )
      .sort((left, right) => left[1].lastUsed - right[1].lastUsed);
    const candidate = candidates[0];
    if (!candidate) return undefined;
    const [key, entry] = candidate;
    return await this.#release(key, entry) ? key : undefined;
  }

  async releaseWhenIdle(key: string): Promise<boolean> {
    const entry = this.#require(key);
    if (!entry.resident) return true;
    if (entry.releasing) return entry.releasing;
    if (entry.inUse === 0) return this.#release(key, entry);

    entry.releaseRequested = true;
    return await new Promise<boolean>((resolve) => {
      entry.releaseWaiters.push(resolve);
    });
  }

  isResident(key: string): boolean {
    return this.#entries.get(key)?.resident === true;
  }

  dispose(): void {
    for (const entry of this.#entries.values()) {
      if (entry.timer !== undefined) this.#clearTimer(entry.timer);
      entry.timer = undefined;
      entry.releaseRequested = false;
      this.#resolveReleaseWaiters(entry, false);
    }
  }

  #schedule(key: string, entry: ModelEntry): void {
    if (entry.timer !== undefined) {
      this.#clearTimer(entry.timer);
      entry.timer = undefined;
    }
    if (
      !this.#underMemoryPressure ||
      !entry.resident ||
      entry.inUse > 0 ||
      entry.releasing
    ) {
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
    if (!entry.resident || entry.inUse > 0) return false;
    if (entry.releasing) return entry.releasing;
    if (entry.timer !== undefined) {
      this.#clearTimer(entry.timer);
      entry.timer = undefined;
    }
    let failed = false;
    const releasing = Promise.resolve()
      .then(() => entry.release())
      .then(() => {
        entry.resident = false;
        return true;
      })
      .catch((error: unknown) => {
        failed = true;
        this.#onError(key, error);
        return false;
      })
      .finally(() => {
        entry.releasing = undefined;
        entry.releaseRequested = false;
        this.#resolveReleaseWaiters(entry, !failed);
        if (failed) this.#schedule(key, entry);
      });
    entry.releasing = releasing;
    return releasing;
  }

  #resolveReleaseWaiters(entry: ModelEntry, released: boolean): void {
    const waiters = entry.releaseWaiters.splice(0);
    for (const resolve of waiters) resolve(released);
  }

  #require(key: string): ModelEntry {
    const entry = this.#entries.get(key);
    if (!entry) throw new Error(`Unknown resident model: ${key}`);
    return entry;
  }
}
