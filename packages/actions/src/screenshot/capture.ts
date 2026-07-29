import type {
  ActionCommand,
  ActionResult,
} from "@sotto/core";

export type VisiblePngCapture =
  | {
      readonly ok: true;
      readonly dataUrl: string;
    }
  | {
      readonly ok: false;
      readonly result: ActionResult;
    };

function captureOrigin(
  url: string | undefined,
): { host: string } | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    return {
      host: parsed.host,
    };
  } catch {
    return undefined;
  }
}

export async function captureVisiblePng(
  command: ActionCommand,
  accessName: "Screen" | "Screenshot",
): Promise<VisiblePngCapture> {
  const [activeTab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  if (!activeTab || activeTab.windowId === undefined) {
    throw new Error("No active tab is available to capture");
  }

  const captureSite = captureOrigin(activeTab.url);
  if (!captureSite) {
    return {
      ok: false,
      result: { spoken: "I can't capture this page." },
    };
  }

  const hasPermission = await chrome.permissions.contains({
    origins: ["<all_urls>"],
  });
  if (!hasPermission) {
    return {
      ok: false,
      result: {
        spoken: `${accessName} access is needed for ${captureSite.host}.`,
        workflow: {
          kind: "screenshot-permission",
          originPattern: "<all_urls>",
          host: captureSite.host,
          pendingCommand: command,
        },
      },
    };
  }

  return {
    ok: true,
    dataUrl: await chrome.tabs.captureVisibleTab(activeTab.windowId, {
      format: "png",
    }),
  };
}
