import { describe, expect, it } from "vitest";

import {
  findBestTabMatch,
  matchTabTarget,
  scoreTabMatch,
} from "../src/tabs/index.js";
import { chromeTab } from "./chrome-stub.js";

describe("tab fuzzy matching", () => {
  const tabs = [
    chromeTab({
      id: 1,
      windowId: 1,
      title: "Project planning",
      url: "https://docs.example.test/plan",
    }),
    chromeTab({
      id: 2,
      windowId: 1,
      title: "GitHub · sotto",
      url: "https://github.com/example/sotto",
    }),
    chromeTab({
      id: 3,
      windowId: 1,
      title: "Café playlist",
      url: "https://music.example.test/cafe",
    }),
  ];

  it("normalizes protocol, www, punctuation, casing, and diacritics", () => {
    expect(
      scoreTabMatch(
        { url: "https://www.Example.com/café?view=all" },
        "example com cafe view all",
      ),
    ).toBe(1);
  });

  it("finds a title despite a small typo", () => {
    expect(findBestTabMatch(tabs, "githb sotto")?.id).toBe(2);
  });

  it("matches URL data when the title does not contain the target", () => {
    expect(findBestTabMatch(tabs, "docs example")?.id).toBe(1);
  });

  it("uses word coverage to rank partial voice targets", () => {
    expect(findBestTabMatch(tabs, "sotto github project")?.id).toBe(2);
  });

  it("returns no match for empty or weak targets", () => {
    expect(findBestTabMatch(tabs, "")).toBeUndefined();
    expect(findBestTabMatch(tabs, "weather forecast tomorrow")).toBeUndefined();
  });

  it("supports stricter caller-defined thresholds", () => {
    expect(findBestTabMatch(tabs, "githb", 0.99)).toBeUndefined();
  });

  it("keeps the first tab when candidates tie", () => {
    const tied = [
      { id: 10, title: "Inbox" },
      { id: 11, title: "Inbox" },
    ];
    expect(findBestTabMatch(tied, "inbox")?.id).toBe(10);
  });

  it("excludes the prior match and returns the next-best tab", () => {
    const repeated = [
      { id: 10, title: "Inbox" },
      { id: 11, title: "Inbox messages" },
      { id: 12, title: "Calendar" },
    ];

    expect(findBestTabMatch(repeated, "inbox", 0.42, 10)?.id).toBe(11);
  });

  it("returns no match when the excluded tab is the only match", () => {
    expect(
      findBestTabMatch(
        [{ id: 10, title: "Inbox" }, { id: 11, title: "Calendar" }],
        "inbox",
        0.42,
        10,
      ),
    ).toBeUndefined();
  });

  it("does not exclude tabs without an id", () => {
    expect(
      findBestTabMatch([{ title: "Inbox" }], "inbox", 0.42, 10)?.title,
    ).toBe("Inbox");
  });

  it("exposes the same fallback through matchTabTarget", () => {
    expect(matchTabTarget(tabs, "not represented")).toBeUndefined();
  });
});
