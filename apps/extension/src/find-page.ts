import {
  applyFindHighlights,
  createTextMatchRanges,
  FIND_CURRENT_HIGHLIGHT,
  FIND_MATCH_HIGHLIGHT,
  nextMatchIndex,
} from "./find-page-search.js";

type FindOperation =
  | {
      readonly operation: "search";
      readonly query: string;
    }
  | {
      readonly operation: "next" | "clear";
    };

interface FindState {
  ranges: Range[];
  currentIndex: number;
}

interface FindInstall {
  readonly href: string;
  readonly listener: (
    raw: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void,
  ) => void;
  readonly dispose: () => void;
}

declare global {
  var __sottoPageFindInstall: FindInstall | undefined;
}

function parseOperation(raw: unknown): FindOperation | undefined {
  if (
    typeof raw !== "object" ||
    raw === null ||
    Array.isArray(raw)
  ) {
    return undefined;
  }
  const value = raw as Record<string, unknown>;
  if (
    value.target !== "sotto-page-find" ||
    typeof value.epochNonce !== "string" ||
    value.epochNonce.length < 1 ||
    value.epochNonce.length > 128
  ) {
    return undefined;
  }
  if (
    value.operation === "search" &&
    typeof value.query === "string" &&
    value.query.length >= 1 &&
    value.query.length <= 100 &&
    Object.keys(value).every((key) =>
      ["target", "epochNonce", "operation", "query"].includes(key)
    )
  ) {
    return { operation: "search", query: value.query };
  }
  if (
    (value.operation === "next" || value.operation === "clear") &&
    Object.keys(value).every((key) =>
      ["target", "epochNonce", "operation"].includes(key)
    )
  ) {
    return { operation: value.operation };
  }
  return undefined;
}

function isVisibleTextNode(node: Text): boolean {
  if (!node.data.trim()) return false;
  const parent = node.parentElement;
  if (!parent) return false;
  if (
    parent.closest(
      "script, style, noscript, template, [hidden], [aria-hidden='true']",
    )
  ) {
    return false;
  }
  for (
    let element: Element | null = parent;
    element;
    element = element.parentElement
  ) {
    const style = getComputedStyle(element);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse"
    ) {
      return false;
    }
  }
  return true;
}

function visibleTextNodes(): Text[] {
  const root = document.body ?? document.documentElement;
  if (!root) return [];
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        return isVisibleTextNode(node as Text)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    },
  );
  for (
    let node = walker.nextNode();
    node;
    node = walker.nextNode()
  ) {
    nodes.push(node as Text);
  }
  return nodes;
}

function rangeIsVisible(range: Range): boolean {
  return range.getClientRects().length > 0;
}

function renderHighlights(state: FindState): void {
  applyFindHighlights(
    state.ranges,
    state.currentIndex,
    CSS.highlights,
    (...ranges) => new Highlight(...ranges),
  );
}

function clearState(state: FindState): void {
  state.ranges = [];
  state.currentIndex = -1;
  CSS.highlights.delete(FIND_MATCH_HIGHLIGHT);
  CSS.highlights.delete(FIND_CURRENT_HIGHLIGHT);
}

function scrollToCurrent(state: FindState): void {
  const range = state.ranges[state.currentIndex];
  if (!range) return;
  const container = range.startContainer.nodeType === Node.ELEMENT_NODE
    ? range.startContainer as Element
    : range.startContainer.parentElement;
  container?.scrollIntoView({
    block: "center",
    inline: "nearest",
    behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
      ? "instant"
      : "smooth",
  });
}

const previousInstall = globalThis.__sottoPageFindInstall;
if (previousInstall && previousInstall.href !== location.href) {
  previousInstall.dispose();
  globalThis.__sottoPageFindInstall = undefined;
}

if (!globalThis.__sottoPageFindInstall) {
  const injectedHref = location.href;
  const state: FindState = { ranges: [], currentIndex: -1 };
  let navigationTimer: ReturnType<typeof setInterval> | undefined;
  let disposed = false;

  const listener: FindInstall["listener"] = (
    raw,
    _sender,
    sendResponse,
  ): void => {
    const operation = parseOperation(raw);
    if (!operation) return;
    const epoch = {
      href: injectedHref,
      nonce: (raw as { readonly epochNonce: string }).epochNonce,
    };

    try {
      let wrapped = false;
      if (operation.operation === "search") {
        clearState(state);
        state.ranges = createTextMatchRanges(
          visibleTextNodes(),
          operation.query,
          () => new Range(),
        ).filter(rangeIsVisible);
        state.currentIndex = state.ranges.length > 0 ? 0 : -1;
        renderHighlights(state);
        scrollToCurrent(state);
      } else if (operation.operation === "next") {
        const next = nextMatchIndex(
          state.ranges.length,
          state.currentIndex,
        );
        state.currentIndex = next.index;
        wrapped = next.wrapped;
        renderHighlights(state);
        scrollToCurrent(state);
      } else {
        clearState(state);
      }

      sendResponse({
        ok: true,
        epoch,
        value: {
          matches: state.ranges.length,
          wrapped,
        },
      });
      if (operation.operation === "clear") dispose();
    } catch (error) {
      clearState(state);
      sendResponse({
        ok: false,
        epoch,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    clearState(state);
    chrome.runtime.onMessage.removeListener(listener);
    if (navigationTimer !== undefined) clearInterval(navigationTimer);
    window.removeEventListener("pagehide", dispose);
    window.removeEventListener("hashchange", checkForNavigation);
    window.removeEventListener("popstate", checkForNavigation);
    if (globalThis.__sottoPageFindInstall?.listener === listener) {
      globalThis.__sottoPageFindInstall = undefined;
    }
  };

  const checkForNavigation = (): void => {
    if (location.href !== injectedHref) dispose();
  };

  chrome.runtime.onMessage.addListener(listener);
  window.addEventListener("pagehide", dispose);
  window.addEventListener("hashchange", checkForNavigation);
  window.addEventListener("popstate", checkForNavigation);
  // Isolated worlds cannot observe page history method calls directly.
  navigationTimer = setInterval(checkForNavigation, 250);
  globalThis.__sottoPageFindInstall = {
    href: injectedHref,
    listener,
    dispose,
  };
}
