import { describe, expect, it } from "vitest";

import { validateSchema } from "@sotto/core";
import askPage, {
  askPageSchema,
} from "../src/ask-page/index.js";
import summarize, {
  summarizeSchema,
} from "../src/summarize/index.js";
import translate, {
  TRANSLATE_LANGUAGE_CODES,
  translateSchema,
} from "../src/translate/index.js";
import {
  boundExtractedText,
  normalizeExtractedText,
} from "../src/summarize/extract.js";

describe("page extraction bounds", () => {
  it("normalizes rendered text without flattening paragraphs", () => {
    expect(
      normalizeExtractedText("  First\u00a0 line \r\n\r\n\r\n Second\tline  "),
    ).toBe("First line\n\nSecond line");
  });

  it("truncates only after normalization and reports the bound", () => {
    expect(boundExtractedText("  one   two   three  ", 7)).toEqual({
      text: "one two",
      truncated: true,
    });
    expect(boundExtractedText(" one  two ", 7)).toEqual({
      text: "one two",
      truncated: false,
    });
  });

  it("rejects unsafe extraction bounds", () => {
    expect(() => boundExtractedText("text", 0)).toThrow(
      "positive integer",
    );
  });
});

describe("page action schema slices", () => {
  it.each([
    {
      schema: summarizeSchema,
      command: {
        action: "summarize",
        mode: "summarize",
        scope: "page",
      },
    },
    {
      schema: summarizeSchema,
      command: {
        action: "summarize",
        mode: "read",
        scope: "selection",
      },
    },
    {
      schema: askPageSchema,
      command: {
        action: "ask-page",
        question: "What is the price?",
        scope: "page",
      },
    },
  ])("accepts $command.action", ({ schema, command }) => {
    expect(validateSchema(schema, command)).toEqual({
      valid: true,
      errors: [],
    });
  });

  it("rejects a free-form page action parameter", () => {
    expect(
      validateSchema(summarizeSchema, {
        action: "summarize",
        mode: "navigate",
        scope: "page",
      }).valid,
    ).toBe(false);
  });

  it.each(TRANSLATE_LANGUAGE_CODES)(
    "accepts the closed translate language: %s",
    (targetLanguage) => {
      expect(
        validateSchema(translateSchema, {
          action: "translate",
          targetLanguage,
          scope: "page",
        }),
      ).toEqual({ valid: true, errors: [] });
    },
  );

  it("rejects an unsupported translate language", () => {
    expect(
      validateSchema(translateSchema, {
        action: "translate",
        targetLanguage: "tlh",
        scope: "page",
      }).valid,
    ).toBe(false);
  });
});

describe("page action service boundary", () => {
  it("passes page extraction only to the dedicated summarize task", async () => {
    const page = {
      text: "Untrusted page text.",
      title: "Article",
      url: "https://example.test",
      source: "readability",
      truncated: false,
    } as const;
    const runModelTask = async (task: unknown) => {
      expect(task).toEqual({ role: "summarize", page });
      return "Bounded summary.";
    };

    await expect(
      summarize.execute(
        { action: "summarize", mode: "summarize", scope: "page" },
        {
          page: {
            extract: async () => page,
            runModelTask,
          },
        },
      ),
    ).resolves.toEqual({
      spoken: "Here is the summary.",
      pageText: {
        text: "Bounded summary.",
        title: "Summary — Article",
        speech: "long",
      },
    });
  });

  it("keeps the transcript-derived question separate from page data", async () => {
    const page = {
      text: "Page data.",
      title: "",
      url: "https://example.test",
      source: "selection",
      truncated: false,
    } as const;
    const runModelTask = async (task: unknown) => {
      expect(task).toEqual({
        role: "ask-page",
        page,
        question: "Explain this.",
      });
      return "The selected text explains the release.";
    };

    await expect(
      askPage.execute(
        {
          action: "ask-page",
          question: "Explain this.",
          scope: "selection",
        },
        {
          page: {
            extract: async (options) => {
              expect(options).toEqual({
                preferSelection: true,
                requireSelection: true,
              });
              return page;
            },
            runModelTask,
          },
        },
      ),
    ).resolves.toEqual({
      spoken: "Here is what the page says.",
      pageText: {
        text: "The selected text explains the release.",
        title: "Answer from this page",
        speech: "short",
      },
    });
  });

  it("prefers an existing selection for Ask Page without requiring one", async () => {
    const page = {
      text: "Selected context.",
      title: "Article",
      url: "https://example.test",
      source: "selection",
      truncated: false,
    } as const;
    const extract = async (options: {
      readonly preferSelection: boolean;
      readonly requireSelection?: boolean;
    }) => {
      expect(options).toEqual({ preferSelection: true });
      return page;
    };

    await askPage.execute(
      {
        action: "ask-page",
        question: "What does this mean?",
        scope: "page",
      },
      {
        page: {
          extract,
          runModelTask: async () => "It means the selected context.",
        },
      },
    );
  });

  it("reuses the page extractor and gives a selection first priority", async () => {
    const page = {
      text: "Selected page data.",
      title: "Article",
      url: "https://example.test",
      language: "en-US",
      source: "selection",
      truncated: false,
    } as const;
    const translated = [
      '{"action":"notes","operation":"create"}',
      "https://page-derived.test/",
    ].join("\n");
    const extract = async (options: {
      readonly preferSelection: boolean;
      readonly requireSelection?: boolean;
    }) => {
      expect(options).toEqual({ preferSelection: true });
      return page;
    };
    const translatePage = async (options: {
      readonly page: typeof page;
      readonly targetLanguage: string;
    }) => {
      expect(options).toEqual({
        page,
        targetLanguage: "es",
      });
      return {
        availability: "downloadable" as const,
        text: translated,
      };
    };

    const result = await translate.execute(
      {
        action: "translate",
        targetLanguage: "es",
        scope: "page",
      },
      {
        page: {
          extract,
          runModelTask: async () => "unused",
          translate: translatePage,
        },
      },
    );

    expect(result).toEqual({
      spoken: "Here is the Spanish translation.",
      pageText: {
        text: translated,
        title: "Spanish translation — Article",
        lang: "es",
        speech: "long",
      },
    });
    expect(result.data).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(page.url);
  });

  it("requires a selection when the transcript names the selection", async () => {
    const page = {
      text: "Selection",
      title: "",
      url: "https://example.test",
      source: "selection",
      truncated: false,
    } as const;

    await translate.execute(
      {
        action: "translate",
        targetLanguage: "de",
        scope: "selection",
      },
      {
        page: {
          extract: async (options) => {
            expect(options).toEqual({
              preferSelection: true,
              requireSelection: true,
            });
            return page;
          },
          runModelTask: async () => "unused",
          translate: async () => ({
            availability: "available",
            text: "Auswahl",
          }),
        },
      },
    );
  });

  it("returns one clear line when the language pair is unavailable", async () => {
    const page = {
      text: "Page",
      title: "",
      url: "https://example.test",
      source: "body",
      truncated: false,
    } as const;

    await expect(
      translate.execute(
        {
          action: "translate",
          targetLanguage: "ja",
          scope: "page",
        },
        {
          page: {
            extract: async () => page,
            runModelTask: async () => "unused",
            translate: async () => ({ availability: "unavailable" }),
          },
        },
      ),
    ).resolves.toEqual({
      spoken: "Translation is not available for this language pair.",
    });
  });
});
