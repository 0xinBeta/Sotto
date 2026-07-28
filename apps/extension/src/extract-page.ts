import {
  extractPageDocument,
  type ExtractPageOptions,
} from "@sotto/actions/summarize/extract";

declare global {
  var __sottoPageExtractorInstalled: boolean | undefined;
}

if (!globalThis.__sottoPageExtractorInstalled) {
  globalThis.__sottoPageExtractorInstalled = true;
  chrome.runtime.onMessage.addListener(
    (
      raw: unknown,
      _sender,
      sendResponse: (response: unknown) => void,
    ): boolean | void => {
      if (
        typeof raw !== "object" ||
        raw === null ||
        Array.isArray(raw) ||
        (raw as { target?: unknown }).target !== "sotto-page-extractor"
      ) {
        return;
      }

      const options = (raw as { options?: unknown }).options;
      if (
        typeof options !== "object" ||
        options === null ||
        Array.isArray(options)
      ) {
        sendResponse({ ok: false, error: "Invalid extraction options" });
        return;
      }

      try {
        const result = extractPageDocument(
          document,
          options as ExtractPageOptions,
        );
        if (!result) {
          sendResponse({
            ok: false,
            error: (options as ExtractPageOptions).requireSelection
              ? "Select some text first."
              : "Sotto could not find readable text on this page.",
          });
          return;
        }
        sendResponse({ ok: true, value: result });
      } catch (error) {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );
}
