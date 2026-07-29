import { vi } from "vitest";

export function installChromeStub() {
  const stub = {
    tabs: {
      query: vi.fn(),
      get: vi.fn(),
      create: vi.fn(),
      group: vi.fn(),
      remove: vi.fn(),
      ungroup: vi.fn(),
      update: vi.fn(),
      captureVisibleTab: vi.fn(),
      getZoom: vi.fn(),
      setZoom: vi.fn(),
    },
    tabGroups: {
      query: vi.fn(),
      update: vi.fn(),
    },
    bookmarks: {
      create: vi.fn(),
      search: vi.fn(),
      remove: vi.fn(),
    },
    windows: {
      create: vi.fn(),
      getCurrent: vi.fn(),
      remove: vi.fn(),
      update: vi.fn(),
    },
    sessions: {
      getRecentlyClosed: vi.fn(),
      restore: vi.fn(),
    },
    permissions: {
      contains: vi.fn().mockResolvedValue(true),
    },
    scripting: {
      executeScript: vi.fn(),
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
