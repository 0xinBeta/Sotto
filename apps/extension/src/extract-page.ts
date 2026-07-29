import {
  extractPageDocument,
  type ExtractPageOptions,
} from "@sotto/actions/summarize/extract";

declare global {
  var __sottoPageExtractorInstall:
    | {
        readonly href: string;
        readonly listener: (
          raw: unknown,
          sender: chrome.runtime.MessageSender,
          sendResponse: (response: unknown) => void,
        ) => void;
      }
    | undefined;
}

function parseOptions(value: unknown): ExtractPageOptions | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    return undefined;
  }
  const options = value as Record<string, unknown>;
  if (
    !Object.keys(options).every((key) =>
      ["preferSelection", "requireSelection", "maxCharacters"].includes(key)
    ) ||
    (options.preferSelection !== undefined &&
      typeof options.preferSelection !== "boolean") ||
    (options.requireSelection !== undefined &&
      typeof options.requireSelection !== "boolean") ||
    (options.maxCharacters !== undefined &&
      (!Number.isSafeInteger(options.maxCharacters) ||
        (options.maxCharacters as number) < 1 ||
        (options.maxCharacters as number) > 120_000))
  ) {
    return undefined;
  }
  return {
    ...(typeof options.preferSelection === "boolean"
      ? { preferSelection: options.preferSelection }
      : {}),
    ...(typeof options.requireSelection === "boolean"
      ? { requireSelection: options.requireSelection }
      : {}),
    ...(typeof options.maxCharacters === "number"
      ? { maxCharacters: options.maxCharacters }
      : {}),
  };
}

const installed = globalThis.__sottoPageExtractorInstall;
if (installed && installed.href !== location.href) {
  chrome.runtime.onMessage.removeListener(installed.listener);
  globalThis.__sottoPageExtractorInstall = undefined;
}

if (!globalThis.__sottoPageExtractorInstall) {
  const injectedHref = location.href;
  const listener = (
    raw: unknown,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void,
  ): void => {
    if (
      typeof raw !== "object" ||
      raw === null ||
      Array.isArray(raw) ||
      (raw as { target?: unknown }).target !== "sotto-page-extractor" ||
      typeof (raw as { epochNonce?: unknown }).epochNonce !== "string" ||
      (raw as { epochNonce: string }).epochNonce.length < 1 ||
      (raw as { epochNonce: string }).epochNonce.length > 128
    ) {
      return;
    }

    const epoch = {
      href: injectedHref,
      nonce: (raw as { epochNonce: string }).epochNonce,
    };
    try {
      const options = parseOptions(
        (raw as { options?: unknown }).options,
      );
      if (!options) {
        sendResponse({
          ok: false,
          epoch,
          error: "Invalid extraction options",
        });
        return;
      }

      const result = extractPageDocument(
        document,
        options,
      );
      if (!result) {
        sendResponse({
          ok: false,
          epoch,
          error: options.requireSelection
            ? "Select some text first."
            : "Sotto could not find readable text on this page.",
        });
        return;
      }
      sendResponse({ ok: true, epoch, value: result });
    } catch (error) {
      sendResponse({
        ok: false,
        epoch,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      chrome.runtime.onMessage.removeListener(listener);
      if (
        globalThis.__sottoPageExtractorInstall?.listener === listener
      ) {
        globalThis.__sottoPageExtractorInstall = undefined;
      }
    }
  };
  chrome.runtime.onMessage.addListener(listener);
  globalThis.__sottoPageExtractorInstall = {
    href: injectedHref,
    listener,
  };
}
