export class InferenceMutex {
  #tail: Promise<unknown> = Promise.resolve();
  #pending = 0;

  get pending(): number {
    return this.#pending;
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    this.#pending += 1;
    const pending = this.#tail
      .catch(() => undefined)
      .then(task);
    this.#tail = pending.then(
      () => {
        this.#pending -= 1;
      },
      () => {
        this.#pending -= 1;
      },
    );
    return pending;
  }

  async idle(): Promise<void> {
    await this.#tail.catch(() => undefined);
  }
}
