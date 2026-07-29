import { afterEach, describe, expect, it, vi } from "vitest";

const extractPageDocument = vi.hoisted(() => vi.fn());

vi.mock("@sotto/actions/summarize/extract", () => ({
  extractPageDocument,
}));

afterEach(() => {
  delete (
    globalThis as typeof globalThis & {
      __sottoPageExtractorInstall?: unknown;
    }
  ).__sottoPageExtractorInstall;
  vi.resetModules();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("page extractor content bridge", () => {
  it("re-arms one listener across navigation and reinjection", async () => {
    const addListener = vi.fn();
    const removeListener = vi.fn();
    const pageLocation = { href: "https://example.test/one" };
    vi.stubGlobal("location", pageLocation);
    vi.stubGlobal("document", {});
    vi.stubGlobal("chrome", {
      runtime: {
        onMessage: {
          addListener,
          removeListener,
        },
      },
    });

    await import("../src/extract-page.js");
    vi.resetModules();
    await import("../src/extract-page.js");
    pageLocation.href = "https://example.test/two";
    vi.resetModules();
    await import("../src/extract-page.js");

    expect(addListener).toHaveBeenCalledTimes(2);
    expect(removeListener).toHaveBeenCalledWith(
      addListener.mock.calls[0]?.[0],
    );
  });
});
