import { controlMediaElements } from "./media-control-selection.js";
import type { MediaControlOperation } from "@sotto/core";

interface MediaControlInstall {
  readonly href: string;
  readonly listener: (
    raw: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void,
  ) => boolean | void;
}

declare global {
  var __sottoMediaControlInstall: MediaControlInstall | undefined;
}

function parseOperation(raw: unknown): MediaControlOperation | undefined {
  if (
    typeof raw !== "object" ||
    raw === null ||
    Array.isArray(raw)
  ) {
    return undefined;
  }
  const value = raw as Record<string, unknown>;
  if (
    value.target !== "sotto-media-control" ||
    typeof value.epochNonce !== "string" ||
    value.epochNonce.length < 1 ||
    value.epochNonce.length > 128 ||
    (value.operation !== "pause" && value.operation !== "play") ||
    !Object.keys(value).every((key) =>
      ["target", "epochNonce", "operation"].includes(key)
    )
  ) {
    return undefined;
  }
  return value.operation;
}

const installed = globalThis.__sottoMediaControlInstall;
if (installed && installed.href !== location.href) {
  chrome.runtime.onMessage.removeListener(installed.listener);
  globalThis.__sottoMediaControlInstall = undefined;
}

if (!globalThis.__sottoMediaControlInstall) {
  const injectedHref = location.href;
  let listener: MediaControlInstall["listener"];
  const dispose = (): void => {
    chrome.runtime.onMessage.removeListener(listener);
    window.removeEventListener("pagehide", dispose);
    if (globalThis.__sottoMediaControlInstall?.listener === listener) {
      globalThis.__sottoMediaControlInstall = undefined;
    }
  };

  listener = (raw, _sender, sendResponse): boolean | void => {
    const operation = parseOperation(raw);
    if (!operation) return;
    const epoch = {
      href: injectedHref,
      nonce: (raw as { readonly epochNonce: string }).epochNonce,
    };

    void (async () => {
      try {
        if (location.href !== injectedHref) {
          throw new Error("The page changed");
        }
        // This main-frame script cannot reach media in cross-origin iframes.
        // The worker uses the no-media response for that case.
        const media = [
          ...document.querySelectorAll<HTMLMediaElement>("video, audio"),
        ];
        const value = await controlMediaElements(media, operation);
        sendResponse({ ok: true, epoch, value });
      } catch (error) {
        sendResponse({
          ok: false,
          epoch,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        dispose();
      }
    })();
    return true;
  };

  chrome.runtime.onMessage.addListener(listener);
  window.addEventListener("pagehide", dispose);
  globalThis.__sottoMediaControlInstall = {
    href: injectedHref,
    listener,
  };
}
