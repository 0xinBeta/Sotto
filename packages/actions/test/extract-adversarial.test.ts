import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  boundExtractedText,
  extractPageDocument,
  MAX_EXTRACTED_TEXT_LENGTH,
} from "../src/summarize/extract.js";

class FakeHTMLElement {
  shadowRoot: null = null;
}

class FakeInputElement extends FakeHTMLElement {
  value = "";
  selectionStart: number | null = 0;
  selectionEnd: number | null = 0;
}

class FakeTextAreaElement extends FakeInputElement {}

interface DocumentHarness {
  readonly document: Document;
  readonly querySelector: ReturnType<typeof vi.fn>;
  readonly getElementsByTagName: ReturnType<typeof vi.fn>;
}

function fakeDocument(options: {
  readonly activeElement?: Element | null;
  readonly selection?: string;
  readonly article?: string;
  readonly main?: string;
  readonly body?: string;
} = {}): DocumentHarness {
  const values: Record<string, string | undefined> = {
    article: options.article,
    main: options.main,
    body: options.body,
  };
  const querySelector = vi.fn((selector: string) => {
    const innerText = values[selector];
    return innerText === undefined ? null : { innerText };
  });
  const getElementsByTagName = vi.fn(() => ({ length: 50_001 }));
  const document = {
    activeElement: options.activeElement ?? null,
    defaultView: {
      getSelection: () => ({
        toString: () => options.selection ?? "",
      }),
    },
    title: "Test page",
    URL: "https://example.test/article",
    documentElement: { lang: "en" },
    getElementsByTagName,
    querySelector,
  } as unknown as Document;
  return { document, querySelector, getElementsByTagName };
}

beforeEach(() => {
  vi.stubGlobal("HTMLElement", FakeHTMLElement);
  vi.stubGlobal("HTMLInputElement", FakeInputElement);
  vi.stubGlobal("HTMLTextAreaElement", FakeTextAreaElement);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("adversarial page extraction", () => {
  it("enforces the default 120k bound on huge normalized input", () => {
    const result = boundExtractedText(
      ` ${"x".repeat(MAX_EXTRACTED_TEXT_LENGTH + 10_000)} `,
    );

    expect(result.text).toHaveLength(MAX_EXTRACTED_TEXT_LENGTH);
    expect(result.truncated).toBe(true);
  });

  it("does not split a surrogate pair at the extraction boundary", () => {
    const prefix = "x".repeat(MAX_EXTRACTED_TEXT_LENGTH - 1);
    const result = boundExtractedText(`${prefix}🙂tail`);

    expect(result).toEqual({ text: prefix, truncated: true });
    expect(result.text.endsWith("\ud83d")).toBe(false);
  });

  it("rejects a caller-provided bound above the worker data contract", () => {
    expect(() =>
      boundExtractedText("text", MAX_EXTRACTED_TEXT_LENGTH + 1),
    ).toThrow(`must not exceed ${MAX_EXTRACTED_TEXT_LENGTH}`);
  });

  it("gives a focused form-control selection priority over window selection", () => {
    const input = new FakeInputElement();
    input.value = "before chosen after";
    input.selectionStart = 7;
    input.selectionEnd = 13;
    const harness = fakeDocument({
      activeElement: input as unknown as Element,
      selection: "stale page selection",
      article: "article fallback",
    });

    expect(
      extractPageDocument(harness.document, {
        preferSelection: true,
        requireSelection: true,
      }),
    ).toMatchObject({
      text: "chosen",
      source: "selection",
      truncated: false,
    });
    expect(harness.getElementsByTagName).not.toHaveBeenCalled();
    expect(harness.querySelector).not.toHaveBeenCalled();
  });

  it("does not reuse stale window selection when a focused control has a caret", () => {
    const textarea = new FakeTextAreaElement();
    textarea.value = "caret only";
    textarea.selectionStart = 5;
    textarea.selectionEnd = 5;
    const harness = fakeDocument({
      activeElement: textarea as unknown as Element,
      selection: "unrelated retained page selection",
      article: "article fallback",
    });

    expect(
      extractPageDocument(harness.document, {
        preferSelection: true,
        requireSelection: true,
      }),
    ).toBeNull();
    expect(harness.getElementsByTagName).not.toHaveBeenCalled();
    expect(harness.querySelector).not.toHaveBeenCalled();
  });

  it("uses selection before article, then skips whitespace to main", () => {
    const selected = fakeDocument({
      selection: " selected text ",
      article: "article text",
      main: "main text",
      body: "body text",
    });
    expect(extractPageDocument(selected.document)).toMatchObject({
      text: "selected text",
      source: "selection",
    });
    expect(selected.querySelector).not.toHaveBeenCalled();

    const fallback = fakeDocument({
      selection: " ",
      article: " \n\t ",
      main: " main text ",
      body: "body text",
    });
    expect(extractPageDocument(fallback.document)).toMatchObject({
      text: "main text",
      source: "main",
    });
    expect(fallback.querySelector.mock.calls.map(([selector]) => selector)).toEqual(
      ["article", "main"],
    );
  });

  it("falls through to body and returns null for an all-whitespace document", () => {
    const body = fakeDocument({
      article: "",
      main: " ",
      body: " final body ",
    });
    expect(extractPageDocument(body.document)).toMatchObject({
      text: "final body",
      source: "body",
    });

    const empty = fakeDocument({
      selection: "\n",
      article: " ",
      main: "\t",
      body: "\r\n",
    });
    expect(extractPageDocument(empty.document)).toBeNull();
    expect(empty.querySelector.mock.calls.map(([selector]) => selector)).toEqual(
      ["article", "main", "body"],
    );
  });
});
