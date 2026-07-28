import { vi } from "vitest";

import type {
  AlarmStoreLike,
  StorageAreaLike,
} from "../src/notes/storage.js";

export class MemoryStorageArea implements StorageAreaLike {
  readonly values: Record<string, unknown>;
  readonly setAccessLevel = vi.fn(async () => undefined);
  readonly get = vi.fn(
    async (
      keys?: string | readonly string[] | null,
    ): Promise<Record<string, unknown>> => {
      if (keys === undefined || keys === null) return { ...this.values };
      const selected = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(
        selected
          .filter((key) =>
            Object.prototype.hasOwnProperty.call(this.values, key),
          )
          .map((key) => [key, this.values[key]]),
      );
    },
  );
  readonly set = vi.fn(
    async (items: Record<string, unknown>): Promise<void> => {
      Object.assign(this.values, items);
    },
  );

  constructor(initial: Record<string, unknown> = {}) {
    this.values = { ...initial };
  }
}

export class MemoryAlarmStore implements AlarmStoreLike {
  readonly alarms = new Map<string, { name: string; when: number }>();
  readonly get = vi.fn(async (name: string) => this.alarms.get(name));
  readonly create = vi.fn(
    async (name: string, alarmInfo: { readonly when: number }) => {
      this.alarms.set(name, { name, when: alarmInfo.when });
    },
  );
  readonly clear = vi.fn(async (name: string) => this.alarms.delete(name));
}

