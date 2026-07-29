import { validateSchema } from "@sotto/core";
import { beforeEach, describe, expect, it } from "vitest";

import navigateAction, {
  navigateSchema,
  sanitizeHostname,
} from "../src/navigate/index.js";
import { installChromeStub } from "./chrome-stub.js";

describe("navigate action", () => {
  let chromeStub: ReturnType<typeof installChromeStub>;

  beforeEach(() => {
    chromeStub = installChromeStub();
  });

  it.each([
    ["github.com", "github.com"],
    ["WWW.Example.COM", "www.example.com"],
    ["a.co", "a.co"],
    ["sub-domain.example.co.uk", "sub-domain.example.co.uk"],
    ["  docs.python.org  ", "docs.python.org"],
    ["3com.com", "3com.com"],
  ])("accepts the valid hostname %s", (site, expected) => {
    expect(sanitizeHostname(site)).toBe(expected);
  });

  it.each([
    "https://github.com",
    "http://github.com",
    "file://etc/passwd",
    "javascript:alert(1)",
    "git hub.com",
    "gіthub.com",
    "github.com/path",
    "github.com:443",
    "user@github.com",
    "192.168.0.1",
    "[2001:db8::1]",
    "localhost",
    ".example.com",
    "example..com",
    "example.com.",
    "-example.com",
    "example-.com",
    "example.123",
  ])("refuses the unsafe hostname %s", (site) => {
    expect(sanitizeHostname(site)).toBeUndefined();
  });

  it("keeps open and search fields in separate bounded schemas", () => {
    expect(
      validateSchema(navigateSchema, {
        action: "navigate",
        operation: "open",
        site: "a.co",
      }).valid,
    ).toBe(true);
    expect(
      validateSchema(navigateSchema, {
        action: "navigate",
        operation: "search",
        query: "x".repeat(200),
      }).valid,
    ).toBe(true);

    for (const candidate of [
      { action: "navigate", operation: "open", site: "x.co", query: "x" },
      { action: "navigate", operation: "open", site: "abc" },
      {
        action: "navigate",
        operation: "open",
        site: "x".repeat(101),
      },
      { action: "navigate", operation: "search", query: "" },
      {
        action: "navigate",
        operation: "search",
        query: "x".repeat(201),
      },
      {
        action: "navigate",
        operation: "open",
        site: "github.com",
        url: "javascript:alert(1)",
      },
    ]) {
      expect(validateSchema(navigateSchema, candidate).valid).toBe(false);
    }
  });

  it("builds an HTTPS URL from the sanitized host in a new tab", async () => {
    await expect(
      navigateAction.execute(
        {
          action: "navigate",
          operation: "open",
          site: "  Docs.Python.org  ",
        },
        {},
      ),
    ).resolves.toEqual({ spoken: "Opening docs.python.org." });

    expect(chromeStub.tabs.create).toHaveBeenCalledWith({
      url: "https://docs.python.org/",
      active: true,
    });
    expect(chromeStub.tabs.update).not.toHaveBeenCalled();
  });

  it("refuses an unsafe site without opening or changing a tab", async () => {
    await expect(
      navigateAction.execute(
        {
          action: "navigate",
          operation: "open",
          site: "https://github.com",
        },
        {},
      ),
    ).resolves.toEqual({ spoken: "I did not catch a site name." });

    expect(chromeStub.tabs.create).not.toHaveBeenCalled();
    expect(chromeStub.tabs.update).not.toHaveBeenCalled();
  });

  it("encodes the transcript query and opens a new Google tab", async () => {
    await expect(
      navigateAction.execute(
        {
          action: "navigate",
          operation: "search",
          query: "  cats & dogs/日本  ",
        },
        {},
      ),
    ).resolves.toEqual({ spoken: "Searching." });

    expect(chromeStub.tabs.create).toHaveBeenCalledWith({
      url: `https://www.google.com/search?q=${encodeURIComponent(
        "cats & dogs/日本",
      )}`,
      active: true,
    });
    expect(chromeStub.tabs.update).not.toHaveBeenCalled();
  });

  it("refuses a blank query without opening a tab", async () => {
    await expect(
      navigateAction.execute(
        {
          action: "navigate",
          operation: "search",
          query: "   ",
        },
        {},
      ),
    ).resolves.toEqual({ spoken: "I did not catch a search query." });

    expect(chromeStub.tabs.create).not.toHaveBeenCalled();
    expect(chromeStub.tabs.update).not.toHaveBeenCalled();
  });
});
