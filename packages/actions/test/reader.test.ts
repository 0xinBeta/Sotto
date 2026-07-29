import { describe, expect, it, vi } from "vitest";

import type { PageActionServices } from "@sotto/core";
import { validateSchema } from "@sotto/core";
import readerAction, {
  readerSchema,
} from "../src/reader/index.js";

describe("reader action", () => {
  it("accepts only the reader command", () => {
    expect(validateSchema(readerSchema, { action: "reader" }).valid).toBe(true);
    expect(
      validateSchema(readerSchema, {
        action: "reader",
        text: "Page text",
      }).valid,
    ).toBe(false);
  });

  it("uses the page extractor and returns display-only reader text", async () => {
    const extract = vi.fn().mockResolvedValue({
      text: "First paragraph.\n\nSecond paragraph.",
      title: "Local article",
      url: "https://example.test/article",
      language: "en",
      source: "readability",
      truncated: false,
    });

    await expect(
      readerAction.execute(
        { action: "reader" },
        {
          page: {
            extract,
          } as unknown as PageActionServices,
        },
      ),
    ).resolves.toEqual({
      spoken: "Reader is open.",
      pageText: {
        text: "First paragraph.\n\nSecond paragraph.",
        title: "Local article",
        lang: "en",
        speech: "none",
        view: "reader",
      },
    });
    expect(extract).toHaveBeenCalledWith({ preferSelection: false });
  });

  it("does not create a title when extraction has no title", async () => {
    const page = {
      extract: vi.fn().mockResolvedValue({
        text: "Local text.",
        title: "",
        url: "https://example.test/article",
        source: "article",
        truncated: false,
      }),
    } as unknown as PageActionServices;

    const result = await readerAction.execute({ action: "reader" }, { page });

    expect(result.pageText).toEqual({
      text: "Local text.",
      speech: "none",
      view: "reader",
    });
  });
});
