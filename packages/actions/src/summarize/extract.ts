import {
  Readability,
  isProbablyReaderable,
} from "@mozilla/readability";
import type { ExtractedPageText } from "@sotto/core";

type ReadabilityResult = NonNullable<ReturnType<Readability["parse"]>>;

export const MAX_DOCUMENT_ELEMENTS = 50_000;
export const MAX_EXTRACTED_TEXT_LENGTH = 120_000;
export const MIN_READABILITY_TEXT_LENGTH = 200;

export interface ExtractPageOptions {
  readonly preferSelection?: boolean;
  readonly requireSelection?: boolean;
  readonly maxCharacters?: number;
}

export function normalizeExtractedText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\t\f\v\u00a0 ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function boundExtractedText(
  value: string,
  maxCharacters = MAX_EXTRACTED_TEXT_LENGTH,
): { readonly text: string; readonly truncated: boolean } {
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 1) {
    throw new RangeError("Extraction character bound must be a positive integer");
  }
  const normalized = normalizeExtractedText(value);
  if (normalized.length <= maxCharacters) {
    return { text: normalized, truncated: false };
  }
  return {
    text: normalized.slice(0, maxCharacters).trimEnd(),
    truncated: true,
  };
}

function deepestActiveElement(document: Document): Element | null {
  let active: Element | null = document.activeElement;
  while (
    active instanceof HTMLElement &&
    active.shadowRoot?.activeElement
  ) {
    active = active.shadowRoot.activeElement;
  }
  return active;
}

function selectedText(document: Document): string {
  const active = deepestActiveElement(document);
  if (
    (active instanceof HTMLInputElement ||
      active instanceof HTMLTextAreaElement) &&
    typeof active.selectionStart === "number" &&
    typeof active.selectionEnd === "number" &&
    active.selectionEnd > active.selectionStart
  ) {
    return active.value.slice(active.selectionStart, active.selectionEnd);
  }
  return document.defaultView?.getSelection()?.toString() ?? "";
}

function pageMetadata(
  document: Document,
  article?: ReadabilityResult | null,
): Pick<ExtractedPageText, "title" | "url" | "language"> {
  const title = normalizeExtractedText(article?.title ?? document.title).slice(
    0,
    500,
  );
  const url = document.URL.slice(0, 4_000);
  const language = normalizeExtractedText(
    article?.lang ?? document.documentElement.lang,
  ).slice(0, 35);
  return {
    title,
    url,
    ...(language ? { language } : {}),
  };
}

function makeResult(
  document: Document,
  source: ExtractedPageText["source"],
  rawText: string,
  maxCharacters: number,
  article?: ReadabilityResult | null,
): ExtractedPageText | null {
  const bounded = boundExtractedText(rawText, maxCharacters);
  if (!bounded.text) return null;
  return {
    ...pageMetadata(document, article),
    source,
    ...bounded,
  };
}

/**
 * Runs only after an explicit user command inside the isolated content-script
 * world. Readability receives a clone and never mutates the live document.
 */
export function extractPageDocument(
  document: Document,
  options: ExtractPageOptions = {},
): ExtractedPageText | null {
  const maxCharacters =
    options.maxCharacters ?? MAX_EXTRACTED_TEXT_LENGTH;
  const selection = selectedText(document);

  if (options.preferSelection) {
    const result = makeResult(
      document,
      "selection",
      selection,
      maxCharacters,
    );
    if (result || options.requireSelection) return result;
  }

  if (!options.requireSelection) {
    const elementCount = document.getElementsByTagName("*").length;
    if (
      elementCount <= MAX_DOCUMENT_ELEMENTS &&
      isProbablyReaderable(document)
    ) {
      try {
        const clone = document.cloneNode(true) as Document;
        const article = new Readability(clone, {
          maxElemsToParse: MAX_DOCUMENT_ELEMENTS,
        }).parse();
        const articleText = normalizeExtractedText(article?.textContent ?? "");
        if (articleText.length >= MIN_READABILITY_TEXT_LENGTH) {
          return makeResult(
            document,
            "readability",
            articleText,
            maxCharacters,
            article,
          );
        }
      } catch {
        // Bounded DOM fallbacks below are the deliberate fail-soft path.
      }
    }
  }

  const selectionResult = makeResult(
    document,
    "selection",
    selection,
    maxCharacters,
  );
  if (selectionResult || options.requireSelection) return selectionResult;

  for (const [source, selector] of [
    ["article", "article"],
    ["main", "main"],
    ["body", "body"],
  ] as const) {
    const element = document.querySelector<HTMLElement>(selector);
    const result = makeResult(
      document,
      source,
      element?.innerText ?? "",
      maxCharacters,
    );
    if (result) return result;
  }

  return null;
}
