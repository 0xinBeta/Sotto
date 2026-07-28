import { vi } from "vitest";

export function installChromeStub() {
  const stub = {
    tabs: {
      query: vi.fn(),
      get: vi.fn(),
      create: vi.fn(),
      remove: vi.fn(),
      update: vi.fn(),
      captureVisibleTab: vi.fn(),
    },
    windows: {
      update: vi.fn(),
    },
    sessions: {
      getRecentlyClosed: vi.fn(),
      restore: vi.fn(),
    },
  };

  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: stub,
  });

  return stub;
}

export function chromeTab(
  values: Partial<chrome.tabs.Tab> & Pick<chrome.tabs.Tab, "windowId">,
): chrome.tabs.Tab {
  return values as chrome.tabs.Tab;
}
