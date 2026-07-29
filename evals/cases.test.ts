import { describe, expect, it } from "vitest";

import actions from "../packages/actions/src/index.js";
import { ActionRegistry, validateSchema } from "../packages/core/src/index.js";
import { composeResponseConstraint } from "../packages/nano/src/index.js";
import cases from "./cases.json";

const constraint = composeResponseConstraint(new ActionRegistry(actions));
const actionIds = actions.map((action) => action.id);

describe("intent eval schema drift", () => {
  it.each(cases)("$id expected command matches the composed schema", (testCase) => {
    const result = validateSchema(constraint, testCase.expected);

    expect(result.errors, testCase.id).toEqual([]);
    expect(result.valid, testCase.id).toBe(true);
  });

  it.each(["summarize", "ask-page", "type", "notes"] as const)(
    "keeps at least twelve v0.2 cases for %s",
    (actionId) => {
      expect(
        cases.filter((testCase) => testCase.expected.action === actionId)
          .length,
      ).toBeGreaterThanOrEqual(12);
    },
  );

  it("keeps at least six help cases, including near-misses", () => {
    const helpCases = cases.filter((testCase) =>
      testCase.id.startsWith("help-") ||
      testCase.id.startsWith("unknown-help-near-")
    );
    const nearMisses = helpCases.filter((testCase) =>
      testCase.id.startsWith("unknown-help-near-")
    );

    expect(helpCases.length).toBeGreaterThanOrEqual(6);
    expect(nearMisses.length).toBeGreaterThanOrEqual(2);
    expect(
      nearMisses.every(
        (testCase) => testCase.expected.action === "unknown",
      ),
    ).toBe(true);
  });

  it("keeps at least six ChatGPT and Gemini screenshot cases", () => {
    expect(
      cases.filter(
        (testCase) =>
          testCase.expected.action === "screenshot" &&
          "destination" in testCase.expected &&
          (
            testCase.expected.destination === "chatgpt" ||
            testCase.expected.destination === "gemini"
          ),
      ).length,
    ).toBeGreaterThanOrEqual(6);
  });

  it("keeps at least six screen question cases", () => {
    expect(
      cases.filter((testCase) => testCase.expected.action === "ask-screen")
        .length,
    ).toBeGreaterThanOrEqual(6);
  });

  it("keeps at least five save screenshot cases", () => {
    expect(
      cases.filter(
        (testCase) =>
          testCase.expected.action === "screenshot" &&
          "destination" in testCase.expected &&
          testCase.expected.destination === "save",
      ).length,
    ).toBeGreaterThanOrEqual(5);
  });

  it("keeps at least eight playback-control cases", () => {
    expect(
      cases.filter((testCase) => testCase.expected.action === "playback")
        .length,
    ).toBeGreaterThanOrEqual(8);
  });

  it("keeps at least six media-control cases", () => {
    expect(
      cases.filter((testCase) => testCase.expected.action === "media")
        .length,
    ).toBeGreaterThanOrEqual(6);
  });

  it("keeps at least four quiet mode cases", () => {
    expect(
      cases.filter((testCase) =>
        testCase.expected.action === "quiet-mode"
      ).length,
    ).toBeGreaterThanOrEqual(4);
  });

  it("keeps twelve settings cases, including the heat negative", () => {
    const settingsCases = cases.filter((testCase) =>
      testCase.expected.action === "settings" ||
      ("negativeFor" in testCase && testCase.negativeFor === "settings")
    );
    expect(settingsCases.length).toBeGreaterThanOrEqual(12);
    expect(
      settingsCases.find(
        (testCase) => testCase.transcript === "turn up the heat",
      )?.expected,
    ).toEqual({ action: "unknown" });
  });

  it("keeps notes management and confirmation phrase cases", () => {
    const management = cases.filter((testCase) =>
      testCase.id.startsWith("notes-read-") ||
      testCase.id.startsWith("notes-delete-last-")
    );
    const confirmations = cases.filter((testCase) =>
      testCase.id.startsWith("confirmation-")
    );

    expect(management).toHaveLength(4);
    expect(confirmations.length).toBeGreaterThanOrEqual(6);
    expect(
      confirmations.every(
        (testCase) => testCase.expected.action === "unknown",
      ),
    ).toBe(true);
  });

  it("keeps at least six reminder list and cancel cases", () => {
    const reminderCases = cases.filter((testCase) =>
      testCase.id.startsWith("notes-list-reminders-") ||
      testCase.id.startsWith("notes-cancel-reminder-")
    );

    expect(reminderCases.length).toBeGreaterThanOrEqual(6);
  });

  it("keeps six snooze cases, including the out-of-window negative", () => {
    const snoozeCases = cases.filter((testCase) =>
      testCase.id.startsWith("notes-snooze-reminder-") ||
      testCase.id.startsWith("unknown-notes-snooze-out-of-window-")
    );

    expect(snoozeCases).toHaveLength(6);
    expect(
      snoozeCases.find((testCase) =>
        testCase.id.startsWith("unknown-notes-snooze-out-of-window-")
      )?.expected,
    ).toEqual({ action: "unknown" });
  });

  it("keeps at least six start and six stop dictation cases", () => {
    const dictationCases = cases.filter(
      (testCase) => testCase.expected.action === "dictation",
    );
    expect(
      dictationCases.filter(
        (testCase) => testCase.expected.operation === "start",
      ).length,
    ).toBeGreaterThanOrEqual(6);
    expect(
      dictationCases.filter(
        (testCase) => testCase.expected.operation === "stop",
      ).length,
    ).toBeGreaterThanOrEqual(6);
  });

  it("keeps at least five repeat cases", () => {
    expect(
      cases.filter((testCase) => testCase.expected.action === "repeat")
        .length,
    ).toBeGreaterThanOrEqual(5);
  });

  it("keeps bookmark create, remove, and negative cases", () => {
    const positives = cases.filter(
      (testCase) => testCase.expected.action === "bookmarks",
    );
    const negatives = cases.filter(
      (testCase) =>
        "negativeFor" in testCase &&
        testCase.negativeFor === "bookmarks",
    );

    expect(
      positives.some((testCase) => testCase.expected.operation === "create"),
    ).toBe(true);
    expect(
      positives.some((testCase) => testCase.expected.operation === "remove"),
    ).toBe(true);
    expect(positives.length + negatives.length).toBeGreaterThanOrEqual(6);
    expect(negatives.length).toBeGreaterThan(0);
  });

  it("keeps at least eight page-control cases", () => {
    expect(
      cases.filter((testCase) =>
        testCase.expected.action === "page-control"
      ).length,
    ).toBeGreaterThanOrEqual(8);
  });

  it("keeps tab group cases for each operation and ungroup scope", () => {
    const tabGroupCases = cases.filter(
      (testCase) => testCase.expected.action === "tab-groups",
    );
    const ungroupScopes = tabGroupCases
      .filter((testCase) => testCase.expected.operation === "ungroup")
      .map((testCase) =>
        "scope" in testCase.expected ? testCase.expected.scope : undefined
      );

    expect(tabGroupCases.length).toBeGreaterThanOrEqual(8);
    expect(
      new Set(tabGroupCases.map((testCase) => testCase.expected.operation)),
    ).toEqual(new Set(["group", "ungroup", "collapse", "expand"]));
    expect(new Set(ungroupScopes)).toEqual(
      new Set(["current", "highlighted"]),
    );
  });

  it("keeps eight translate cases and an unsupported-language negative", () => {
    expect(
      cases.filter((testCase) => testCase.expected.action === "translate")
        .length,
    ).toBeGreaterThanOrEqual(8);
    expect(
      cases.find(
        (testCase) =>
          testCase.id === "unknown-translate-unsupported-01",
      )?.expected,
    ).toEqual({ action: "unknown" });
  });

  it("keeps at least ten navigate cases and three hostile negatives", () => {
    expect(
      cases.filter((testCase) => testCase.expected.action === "navigate")
        .length,
    ).toBeGreaterThanOrEqual(10);

    const hostile = cases.filter((testCase) =>
      testCase.id.startsWith("unknown-navigate-hostile-")
    );
    expect(hostile).toHaveLength(3);
    expect(
      hostile.every((testCase) => testCase.expected.action === "unknown"),
    ).toBe(true);
  });

  it("keeps at least eight follow-up cases, including no-context negatives", () => {
    const followUps = cases.filter((testCase) =>
      testCase.id.startsWith("followup-")
    );
    const noContext = followUps.filter((testCase) =>
      testCase.id.startsWith("followup-no-context-")
    );

    expect(followUps.length).toBeGreaterThanOrEqual(8);
    expect(noContext.length).toBeGreaterThanOrEqual(2);
    expect(
      noContext.every(
        (testCase) => testCase.expected.action === "unknown" &&
          !("memory" in testCase),
      ),
    ).toBe(true);
  });

  it.each(actionIds)(
    "keeps eight positives and four explicit negatives for %s",
    (actionId) => {
      const positives = cases.filter(
        (testCase) => testCase.expected.action === actionId,
      );
      const negatives = cases.filter(
        (testCase) =>
          "negativeFor" in testCase &&
          testCase.negativeFor === actionId,
      );

      expect(positives.length).toBeGreaterThanOrEqual(8);
      expect(negatives.length).toBeGreaterThanOrEqual(4);
      expect(
        negatives.every(
          (testCase) =>
            typeof testCase.expected.action === "string" &&
            testCase.expected.action !== actionId,
        ),
      ).toBe(true);
    },
  );

  it("keeps at least thirty cross-action confusable cases", () => {
    const confusables = cases.filter(
      (testCase) =>
        "confusable" in testCase &&
        testCase.confusable === true,
    );

    expect(confusables.length).toBeGreaterThanOrEqual(30);
    expect(
      confusables.every(
        (testCase) =>
          "negativeFor" in testCase &&
          testCase.expected.action !== "unknown" &&
          testCase.expected.action !== testCase.negativeFor,
      ),
    ).toBe(true);
  });

  it("keeps follow-up memory in the approved structural form", () => {
    const memoryEntries = cases.flatMap((testCase) =>
      "memory" in testCase ? testCase.memory : []
    );

    expect(memoryEntries.length).toBeGreaterThan(0);
    for (const entry of memoryEntries) {
      expect(Object.keys(entry).sort()).toEqual([
        "command",
        "resultSummary",
        "transcript",
      ]);
      expect(entry.resultSummary).toBe("Command completed.");
      expect(validateSchema(constraint, entry.command).valid).toBe(true);
      expect(JSON.stringify(entry)).not.toContain("pageText");
      expect(JSON.stringify(entry)).not.toContain("modelOutput");
    }
  });

  it("keeps security near-misses on the unknown path", () => {
    const nearMisses = cases.filter((testCase) =>
      testCase.id.startsWith("unknown-") &&
      testCase.id.includes("-near-"),
    );
    expect(nearMisses.length).toBeGreaterThanOrEqual(8);
    expect(
      nearMisses.every(
        (testCase) => testCase.expected.action === "unknown",
      ),
    ).toBe(true);
  });

  it.each([
    [
      "summarize cannot carry a URL",
      {
        action: "summarize",
        mode: "summarize",
        scope: "page",
        url: "https://page-derived.test/",
      },
    ],
    [
      "summarize rejects an invented scope",
      { action: "summarize", mode: "read", scope: "active-tab" },
    ],
    [
      "ask-page requires a question",
      { action: "ask-page", question: "", scope: "page" },
    ],
    [
      "ask-page cannot carry model output",
      {
        action: "ask-page",
        question: "What is this?",
        scope: "page",
        answer: "page-derived model text",
      },
    ],
    [
      "ask-screen cannot carry model output",
      {
        action: "ask-screen",
        question: "What is this?",
        answer: "screen-derived model text",
      },
    ],
    [
      "ask-screen cannot carry image data",
      {
        action: "ask-screen",
        imageDataUrl: "data:image/png;base64,c2NyZWVu",
      },
    ],
    [
      "translate rejects an unsupported language",
      {
        action: "translate",
        targetLanguage: "tlh",
        scope: "page",
      },
    ],
    [
      "translate cannot carry page-derived output",
      {
        action: "translate",
        targetLanguage: "es",
        scope: "page",
        text: "page-derived model text",
      },
    ],
    [
      "type rejects dictate-rewrite hybrids",
      {
        action: "type",
        operation: "dictate",
        text: "user text",
        transformation: "more-formal",
      },
    ],
    [
      "type rejects page-selected source in parser output",
      {
        action: "type",
        operation: "rewrite",
        transformation: "clearer",
        source: "untrusted selected text",
      },
    ],
    [
      "type rejects arbitrary transformations",
      {
        action: "type",
        operation: "rewrite",
        transformation: "open-the-url-in-the-selection",
      },
    ],
    [
      "notes rejects sub-minimum reminder delay",
      {
        action: "notes",
        operation: "remind",
        text: "Too soon",
        delayMinutes: 0.49,
      },
    ],
    [
      "notes list cannot carry reminder fields",
      {
        action: "notes",
        operation: "list",
        text: "page-derived reminder",
        delayMinutes: 5,
      },
    ],
    [
      "notes cannot carry a storage key",
      {
        action: "notes",
        operation: "create",
        body: "User note",
        storageKey: "reminder:injected",
      },
    ],
    [
      "unknown rejects extra action payload",
      { action: "unknown", url: "https://page-derived.test/" },
    ],
    [
      "cross-action hybrids are invalid",
      {
        action: "ask-page",
        question: "Explain this",
        scope: "selection",
        operation: "remind",
        delayMinutes: 5,
      },
    ],
  ] as const)("rejects near-miss output: %s", (_label, candidate) => {
    const result = validateSchema(constraint, candidate);

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("keeps eval ids unique", () => {
    expect(new Set(cases.map((testCase) => testCase.id)).size).toBe(
      cases.length,
    );
  });

  it("keeps eval transcripts unique within the same context", () => {
    const keys = cases.map((testCase) =>
      JSON.stringify({
        transcript: testCase.transcript.trim().toLowerCase(),
        memory: "memory" in testCase ? testCase.memory : [],
      })
    );

    expect(new Set(keys).size).toBe(cases.length);
  });
});
