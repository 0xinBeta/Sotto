import { describe, expect, it, vi } from "vitest";

import {
  BLOCKED_HOSTNAMES_KEY,
  BlockedSitesStore,
  hostnameFromUrl,
  hostnameMatchesBlocked,
  normalizeBlockedHostnames,
} from "../src/blocked-sites.js";

describe("blocked site matching", () => {
  it("matches an exact hostname", () => {
    expect(hostnameMatchesBlocked("example.com", ["example.com"])).toBe(true);
  });

  it("matches a subdomain of a blocked hostname", () => {
    expect(
      hostnameMatchesBlocked("news.eu.example.com", ["example.com"]),
    ).toBe(true);
  });

  it("does not match a different hostname or a suffix without a label", () => {
    expect(hostnameMatchesBlocked("example.org", ["example.com"])).toBe(false);
    expect(hostnameMatchesBlocked("notexample.com", ["example.com"])).toBe(
      false,
    );
  });

  it("normalizes only hostnames accepted by the navigation sanitizer", () => {
    expect(
      normalizeBlockedHostnames([
        " Example.com ",
        "*.example.org",
        "example.com",
        "https://example.net",
      ]),
    ).toEqual(["example.com"]);
  });
});

describe("blocked site settings", () => {
  it("derives the quick-add hostname from the active tab URL", () => {
    expect(
      hostnameFromUrl("https://News.Example.com:8443/story?q=local"),
    ).toBe("news.example.com");
    expect(hostnameFromUrl("chrome://settings/")).toBeUndefined();
  });

  it("adds and removes a local blocked hostname", async () => {
    const values: Record<string, unknown> = {};
    const set = vi.fn(async (updates: Record<string, unknown>) => {
      Object.assign(values, updates);
    });
    const store = new BlockedSitesStore({
      get: vi.fn(async (key: string) => (
        key in values ? { [key]: values[key] } : {}
      )),
      set,
    });

    await expect(store.add("EXAMPLE.COM")).resolves.toEqual(["example.com"]);
    expect(values[BLOCKED_HOSTNAMES_KEY]).toEqual(["example.com"]);
    await expect(store.remove("example.com")).resolves.toEqual([]);
    expect(values[BLOCKED_HOSTNAMES_KEY]).toEqual([]);
  });
});
