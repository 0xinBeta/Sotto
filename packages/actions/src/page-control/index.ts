import { defineAction } from "@sotto/core";
import type {
  ActionCommand,
  JsonSchema,
} from "@sotto/core";

export type ScrollOperation =
  | "scroll-up"
  | "scroll-down"
  | "top"
  | "bottom";

export type ZoomOperation = "zoom-in" | "zoom-out" | "zoom-reset";

export type PageControlOperation = ScrollOperation | ZoomOperation;

export interface PageControlCommand extends ActionCommand {
  readonly action: "page-control";
  readonly operation: PageControlOperation;
}

const SCROLL_OPERATIONS = new Set<PageControlOperation>([
  "scroll-up",
  "scroll-down",
  "top",
  "bottom",
]);

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 5;
const ZOOM_STEP = 0.2;

function operationSchema(operation: PageControlOperation): JsonSchema {
  return {
    type: "object",
    properties: {
      action: { const: "page-control" },
      operation: { const: operation },
    },
    required: ["action", "operation"],
    additionalProperties: false,
  };
}

export const pageControlSchema = {
  oneOf: [
    operationSchema("scroll-up"),
    operationSchema("scroll-down"),
    operationSchema("top"),
    operationSchema("bottom"),
    operationSchema("zoom-in"),
    operationSchema("zoom-out"),
    operationSchema("zoom-reset"),
  ],
} as const satisfies JsonSchema;

function isScrollOperation(
  operation: PageControlOperation,
): operation is ScrollOperation {
  return SCROLL_OPERATIONS.has(operation);
}

async function activeTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  if (tab?.id === undefined) {
    throw new Error("No active tab is available");
  }
  return tab;
}

export function isRestrictedPage(url: string | undefined): boolean {
  if (!url) return true;
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "http:" &&
      parsed.protocol !== "https:" &&
      parsed.protocol !== "file:"
    ) {
      return true;
    }
    return (
      parsed.hostname === "chromewebstore.google.com" ||
      (parsed.hostname === "chrome.google.com" &&
        parsed.pathname.startsWith("/webstore"))
    );
  } catch {
    return true;
  }
}

export function runScrollOperation(operation: ScrollOperation): void {
  const behavior: ScrollBehavior = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches
    ? "instant"
    : "smooth";

  switch (operation) {
    case "scroll-up":
      window.scrollBy({
        top: -window.innerHeight * 0.8,
        behavior,
      });
      return;
    case "scroll-down":
      window.scrollBy({
        top: window.innerHeight * 0.8,
        behavior,
      });
      return;
    case "top":
      window.scrollTo({ top: 0, behavior });
      return;
    case "bottom":
      window.scrollTo({
        top:
          document.scrollingElement?.scrollHeight ??
          document.documentElement.scrollHeight,
        behavior,
      });
  }
}

async function scrollActivePage(
  operation: ScrollOperation,
): Promise<boolean> {
  const tab = await activeTab();
  if (isRestrictedPage(tab.url)) return false;

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id!, frameIds: [0] },
      func: runScrollOperation,
      args: [operation],
      world: "ISOLATED",
    });
    return true;
  } catch {
    return false;
  }
}

export function calculateZoomLevel(
  current: number,
  operation: ZoomOperation,
): number {
  if (operation === "zoom-reset") return 1;
  if (!Number.isFinite(current)) {
    throw new TypeError("The current zoom level is invalid");
  }
  const delta = operation === "zoom-in" ? ZOOM_STEP : -ZOOM_STEP;
  const stepped = Math.round((current + delta) * 100) / 100;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, stepped));
}

function numberToWords(value: number): string {
  const small = [
    "zero",
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
    "eleven",
    "twelve",
    "thirteen",
    "fourteen",
    "fifteen",
    "sixteen",
    "seventeen",
    "eighteen",
    "nineteen",
  ] as const;
  const tens = [
    "",
    "",
    "twenty",
    "thirty",
    "forty",
    "fifty",
    "sixty",
    "seventy",
    "eighty",
    "ninety",
  ] as const;

  if (value < 20) return small[value]!;
  if (value < 100) {
    const remainder = value % 10;
    return `${tens[Math.floor(value / 10)]}${
      remainder === 0 ? "" : ` ${small[remainder]}`
    }`;
  }
  const remainder = value % 100;
  return `${small[Math.floor(value / 100)]} hundred${
    remainder === 0 ? "" : ` ${numberToWords(remainder)}`
  }`;
}

export function zoomFeedback(level: number): string {
  return `Zoom ${numberToWords(Math.round(level * 100))} percent.`;
}

const scrollResults: Record<ScrollOperation, string> = {
  "scroll-up": "Scrolled up.",
  "scroll-down": "Scrolled down.",
  top: "Moved to the top of the page.",
  bottom: "Moved to the bottom of the page.",
};

const pageControlAction = defineAction<PageControlCommand>({
  id: "page-control",
  title: "Scroll and zoom",
  permissions: ["activeTab", "scripting", "tabs"],
  schema: pageControlSchema,
  examples: [
    {
      say: "scroll down",
      emit: { action: "page-control", operation: "scroll-down" },
    },
    {
      say: "scroll up",
      emit: { action: "page-control", operation: "scroll-up" },
    },
    {
      say: "go to the top",
      emit: { action: "page-control", operation: "top" },
    },
    {
      say: "bottom of the page",
      emit: { action: "page-control", operation: "bottom" },
    },
    {
      say: "zoom in",
      emit: { action: "page-control", operation: "zoom-in" },
    },
    {
      say: "zoom out",
      emit: { action: "page-control", operation: "zoom-out" },
    },
    {
      say: "reset zoom",
      emit: { action: "page-control", operation: "zoom-reset" },
    },
  ],
  confirm: false,
  async execute(command) {
    if (isScrollOperation(command.operation)) {
      if (!await scrollActivePage(command.operation)) {
        return { spoken: "I cannot control this page." };
      }
      return {
        spoken: scrollResults[command.operation],
        silent: true,
      };
    }

    const tab = await activeTab();
    const current = command.operation === "zoom-reset"
      ? 1
      : await chrome.tabs.getZoom(tab.id!);
    const level = calculateZoomLevel(current, command.operation);
    await chrome.tabs.setZoom(tab.id!, level);
    return { spoken: zoomFeedback(level) };
  },
});

export default pageControlAction;
