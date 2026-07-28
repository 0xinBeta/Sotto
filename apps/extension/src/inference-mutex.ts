export type InferencePriority = "background" | "normal" | "transcription";

export interface InferenceRunOptions {
  readonly priority?: InferencePriority;
  readonly signal?: AbortSignal;
}

interface PendingTask {
  readonly task: () => Promise<unknown>;
  readonly priority: number;
  readonly signal?: AbortSignal;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason?: unknown) => void;
  abort?: () => void;
}

const PRIORITY: Record<InferencePriority, number> = {
  background: 0,
  normal: 1,
  transcription: 2,
};

export class InferenceMutex {
  readonly #queue: PendingTask[] = [];
  readonly #idleWaiters = new Set<() => void>();
  #active = false;
  #pending = 0;

  get pending(): number {
    return this.#pending;
  }

  run<T>(
    task: () => Promise<T>,
    options: InferenceRunOptions = {},
  ): Promise<T> {
    if (options.signal?.aborted) {
      return Promise.reject(options.signal.reason);
    }

    return new Promise<T>((resolve, reject) => {
      const pending: PendingTask = {
        task,
        priority: PRIORITY[options.priority ?? "normal"],
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        resolve: (value) => resolve(value as T),
        reject,
      };
      if (options.signal) {
        pending.abort = () => {
          const index = this.#queue.indexOf(pending);
          if (index < 0) return;
          this.#queue.splice(index, 1);
          this.#pending -= 1;
          reject(options.signal?.reason);
          this.#resolveIdle();
        };
        options.signal.addEventListener("abort", pending.abort, {
          once: true,
        });
      }
      this.#pending += 1;
      this.#queue.push(pending);
      this.#drain();
    });
  }

  async idle(): Promise<void> {
    if (this.#pending === 0) return;
    await new Promise<void>((resolve) => {
      this.#idleWaiters.add(resolve);
    });
  }

  #drain(): void {
    if (this.#active || this.#queue.length === 0) return;

    let selectedIndex = 0;
    for (let index = 1; index < this.#queue.length; index += 1) {
      if (
        (this.#queue[index]?.priority ?? 0) >
          (this.#queue[selectedIndex]?.priority ?? 0)
      ) {
        selectedIndex = index;
      }
    }
    const [pending] = this.#queue.splice(selectedIndex, 1);
    if (!pending) return;
    if (pending.abort && pending.signal) {
      pending.signal.removeEventListener("abort", pending.abort);
    }

    this.#active = true;
    void Promise.resolve()
      .then(pending.task)
      .then(pending.resolve, pending.reject)
      .finally(() => {
        this.#active = false;
        this.#pending -= 1;
        this.#resolveIdle();
        this.#drain();
      });
  }

  #resolveIdle(): void {
    if (this.#pending !== 0) return;
    for (const resolve of this.#idleWaiters) resolve();
    this.#idleWaiters.clear();
  }
}
