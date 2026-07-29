import { sanitizeHostname } from "@sotto/actions";
import type { ActionCommand } from "@sotto/core";

export const BLOCKED_HOSTNAMES_KEY = "blockedHostnames";
export const SITE_BLOCKED_RESPONSE = "Sotto is off on this site.";

const PAGE_TOUCHING_ACTIONS = new Set([
  "ask-page",
  "ask-screen",
  "dictation",
  "find",
  "media",
  "page-control",
  "screenshot",
  "summarize",
  "translate",
  "type",
]);

interface BlockedSitesStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
}

export function normalizeBlockedHostnames(
  value: unknown,
): readonly string[] {
  if (!Array.isArray(value)) return [];
  const hostnames = new Set<string>();
  for (const candidate of value) {
    if (typeof candidate !== "string") continue;
    const hostname = sanitizeHostname(candidate);
    if (hostname !== undefined) hostnames.add(hostname);
  }
  return [...hostnames].sort();
}

export function hostnameFromUrl(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    return sanitizeHostname(new URL(url).hostname);
  } catch {
    return undefined;
  }
}

export function hostnameMatchesBlocked(
  hostname: string,
  blockedHostnames: readonly string[],
): boolean {
  const normalized = sanitizeHostname(hostname);
  if (normalized === undefined) return false;
  return blockedHostnames.some((blocked) =>
    normalized === blocked || normalized.endsWith(`.${blocked}`)
  );
}

export function isPageTouchingAction(command: ActionCommand): boolean {
  return PAGE_TOUCHING_ACTIONS.has(command.action);
}

export class BlockedSitesStore {
  readonly #storage: BlockedSitesStorage;

  constructor(storage: BlockedSitesStorage) {
    this.#storage = storage;
  }

  async get(): Promise<readonly string[]> {
    const values = await this.#storage.get(BLOCKED_HOSTNAMES_KEY);
    return normalizeBlockedHostnames(values[BLOCKED_HOSTNAMES_KEY]);
  }

  async add(value: string): Promise<readonly string[]> {
    const hostname = sanitizeHostname(value);
    if (hostname === undefined) {
      throw new TypeError("Enter a valid site name.");
    }
    const current = await this.get();
    if (current.includes(hostname)) return current;
    const next = [...current, hostname].sort();
    await this.#storage.set({ [BLOCKED_HOSTNAMES_KEY]: next });
    return next;
  }

  async remove(value: string): Promise<readonly string[]> {
    const hostname = sanitizeHostname(value);
    if (hostname === undefined) {
      throw new TypeError("Select a valid site name.");
    }
    const current = await this.get();
    const next = current.filter((candidate) => candidate !== hostname);
    if (next.length !== current.length) {
      await this.#storage.set({ [BLOCKED_HOSTNAMES_KEY]: next });
    }
    return next;
  }
}
