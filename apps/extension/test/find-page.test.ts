import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyFindHighlights,
  createTextMatchRanges,
  FIND_CURRENT_HIGHLIGHT,
  FIND_MATCH_HIGHLIGHT,
  nextMatchIndex,
} from "../src/find-page-search.js";

afterEach(() => {
  const install = (
    globalThis as typeof globalThis & {
      __sottoPageFindInstall?: { readonly dispose: () => void };
    }
  ).__sottoPageFindInstall;
  install?.dispose();
  delete (
    globalThis as typeof globalThis & {
      __sottoPageFindInstall?: unknown;
    }
  ).__sottoPageFindInstall;
  vi.useRealTimers();
  vi.resetModules();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("page find ranges and highlights", () => {
  it("creates case-insensitive ranges without changing text nodes", () => {
    const nodes = [
      { data: "Price and PRICE." },
      { data: "No result here." },
    ];
    const ranges = createTextMatchRanges(
      nodes,
      "price",
      () => ({
        start: undefined as
          | { readonly node: (typeof nodes)[number]; readonly offset: number }
          | undefined,
        end: undefined as
          | { readonly node: (typeof nodes)[number]; readonly offset: number }
          | undefined,
        setStart(node: (typeof nodes)[number], offset: number) {
          this.start = { node, offset };
        },
        setEnd(node: (typeof nodes)[number], offset: number) {
          this.end = { node, offset };
        },
      }),
    );

    expect(ranges.map((range) => [
      range.start?.offset,
      range.end?.offset,
    ])).toEqual([
      [0, 5],
      [10, 15],
    ]);
    expect(nodes.map((node) => node.data)).toEqual([
      "Price and PRICE.",
      "No result here.",
    ]);
  });

  it("registers all mocked ranges and the current range", () => {
    const ranges = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const highlights = new Map<string, readonly { id: number }[]>();
    const registry = {
      set: vi.fn((name: string, value: readonly { id: number }[]) =>
        highlights.set(name, value)
      ),
      delete: vi.fn((name: string) => highlights.delete(name)),
    };

    applyFindHighlights(
      ranges,
      1,
      registry,
      (...items) => items,
    );

    expect(highlights.get(FIND_MATCH_HIGHLIGHT)).toEqual(ranges);
    expect(highlights.get(FIND_CURRENT_HIGHLIGHT)).toEqual([{ id: 2 }]);
  });
});

describe("page find match cycle", () => {
  it("moves to the next match and wraps after the last match", () => {
    expect(nextMatchIndex(3, 0)).toEqual({
      index: 1,
      wrapped: false,
    });
    expect(nextMatchIndex(3, 2)).toEqual({
      index: 0,
      wrapped: true,
    });
    expect(nextMatchIndex(0, -1)).toEqual({
      index: -1,
      wrapped: false,
    });
  });
});

describe("page find navigation epoch", () => {
  it("clears the installed search after the page URL changes", async () => {
    vi.useFakeTimers();
    const oldDispose = vi.fn();
    const oldListener = vi.fn();
    (
      globalThis as typeof globalThis & {
        __sottoPageFindInstall?: unknown;
      }
    ).__sottoPageFindInstall = {
      href: "https://example.test/one",
      listener: oldListener,
      dispose: oldDispose,
    };

    const pageLocation = { href: "https://example.test/two" };
    const addListener = vi.fn();
    const removeListener = vi.fn();
    const highlights = {
      delete: vi.fn(),
    };
    const pageWindow = {
      navigation: {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal("location", pageLocation);
    vi.stubGlobal("window", pageWindow);
    vi.stubGlobal("CSS", { highlights });
    vi.stubGlobal("chrome", {
      runtime: {
        onMessage: {
          addListener,
          removeListener,
        },
      },
    });

    await import("../src/find-page.js");

    expect(oldDispose).toHaveBeenCalledOnce();
    expect(addListener).toHaveBeenCalledOnce();

    pageLocation.href = "https://example.test/three";
    await vi.advanceTimersByTimeAsync(250);

    expect(highlights.delete).toHaveBeenCalledWith(FIND_MATCH_HIGHLIGHT);
    expect(highlights.delete).toHaveBeenCalledWith(
      FIND_CURRENT_HIGHLIGHT,
    );
    expect(removeListener).toHaveBeenCalledWith(
      addListener.mock.calls[0]?.[0],
    );
    expect(
      (
        globalThis as typeof globalThis & {
          __sottoPageFindInstall?: unknown;
        }
      ).__sottoPageFindInstall,
    ).toBeUndefined();
  });
});
