import { validateSchema } from "@sotto/core";
import { beforeEach, describe, expect, it } from "vitest";

import pageControlAction, {
  calculateZoomLevel,
  pageControlSchema,
  runScrollOperation,
  zoomFeedback,
  type PageControlOperation,
} from "../src/page-control/index.js";
import { chromeTab, installChromeStub } from "./chrome-stub.js";

describe("page-control schema slices", () => {
  it.each([
    "scroll-up",
    "scroll-down",
    "top",
    "bottom",
    "zoom-in",
    "zoom-out",
    "zoom-reset",
  ] satisfies readonly PageControlOperation[])("accepts %s", (operation) => {
    expect(
      validateSchema(pageControlSchema, {
        action: "page-control",
        operation,
      }),
    ).toEqual({ valid: true, errors: [] });
  });

  it("rejects free-form page-control parameters", () => {
    expect(
      validateSchema(pageControlSchema, {
        action: "page-control",
        operation: "scroll-down",
        amount: "page text",
      }).valid,
    ).toBe(false);
  });
});

describe("page scroll control", () => {
  let chromeStub: ReturnType<typeof installChromeStub>;

  beforeEach(() => {
    chromeStub = installChromeStub();
    chromeStub.tabs.query.mockResolvedValue([
      chromeTab({
        id: 8,
        windowId: 2,
        url: "https://example.test/article",
      }),
    ]);
    chromeStub.scripting.executeScript.mockImplementation(
      async (details: { readonly args?: readonly unknown[] }) => {
        const nonce = details.args?.[1];
        return nonce === undefined
          ? [{ frameId: 0, result: "https://example.test/article" }]
          : [{
              frameId: 0,
              result: {
                epoch: {
                  href: "https://example.test/article",
                  nonce,
                },
              },
            }];
      },
    );
  });

  it.each([
    ["scroll-up", "Scrolled up."],
    ["scroll-down", "Scrolled down."],
    ["top", "Moved to the top of the page."],
    ["bottom", "Moved to the bottom of the page."],
  ] as const)("injects %s into the main frame", async (operation, spoken) => {
    await expect(
      pageControlAction.execute(
        { action: "page-control", operation },
        {},
      ),
    ).resolves.toEqual({ spoken, silent: true });

    expect(chromeStub.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 8, frameIds: [0] },
      func: runScrollOperation,
      args: [operation, expect.any(String)],
      world: "ISOLATED",
    });
    expect(chromeStub.scripting.executeScript).toHaveBeenCalledTimes(2);
  });

  it.each([
    "chrome://settings/",
    "https://chromewebstore.google.com/detail/example",
    "https://chrome.google.com/webstore/detail/example",
  ])("refuses restricted page %s", async (url) => {
    chromeStub.tabs.query.mockResolvedValue([
      chromeTab({ id: 8, windowId: 2, url }),
    ]);

    await expect(
      pageControlAction.execute(
        { action: "page-control", operation: "scroll-down" },
        {},
      ),
    ).resolves.toEqual({
      spoken: "I cannot control this page.",
    });
    expect(chromeStub.scripting.executeScript).not.toHaveBeenCalled();
  });

  it("uses the restricted-page response when Chrome rejects injection", async () => {
    chromeStub.scripting.executeScript.mockRejectedValue(
      new Error("Cannot access this page"),
    );

    await expect(
      pageControlAction.execute(
        { action: "page-control", operation: "scroll-down" },
        {},
      ),
    ).resolves.toEqual({
      spoken: "I cannot control this page.",
    });
  });

  it("discards a scroll result after pushState changes the URL", async () => {
    chromeStub.scripting.executeScript
      .mockImplementationOnce(
        async (details: { readonly args?: readonly unknown[] }) => [{
          frameId: 0,
          result: {
            epoch: {
              href: "https://example.test/article",
              nonce: details.args?.[1],
            },
          },
        }],
      )
      .mockResolvedValueOnce([{
        frameId: 0,
        result: "https://example.test/next",
      }]);

    await expect(
      pageControlAction.execute(
        { action: "page-control", operation: "scroll-down" },
        {},
      ),
    ).resolves.toEqual({
      spoken: "The page changed. Try again.",
    });
  });
});

describe("page zoom control", () => {
  let chromeStub: ReturnType<typeof installChromeStub>;

  beforeEach(() => {
    chromeStub = installChromeStub();
    chromeStub.tabs.query.mockResolvedValue([
      chromeTab({
        id: 12,
        windowId: 3,
        url: "https://example.test/article",
      }),
    ]);
  });

  it.each([
    [1.2, "zoom-in", 1.4],
    [0.3, "zoom-out", 0.25],
    [0.25, "zoom-out", 0.25],
    [4.9, "zoom-in", 5],
    [5, "zoom-in", 5],
    [3, "zoom-reset", 1],
  ] as const)(
    "calculates %s with %s as %s",
    (current, operation, expected) => {
      expect(calculateZoomLevel(current, operation)).toBe(expected);
    },
  );

  it("sets a zoom step and speaks the new level", async () => {
    chromeStub.tabs.getZoom.mockResolvedValue(1.2);

    await expect(
      pageControlAction.execute(
        { action: "page-control", operation: "zoom-in" },
        {},
      ),
    ).resolves.toEqual({
      spoken: "Zoom one hundred forty percent.",
    });

    expect(chromeStub.tabs.getZoom).toHaveBeenCalledWith(12);
    expect(chromeStub.tabs.setZoom).toHaveBeenCalledWith(12, 1.4);
  });

  it("resets zoom without reading the current level", async () => {
    await expect(
      pageControlAction.execute(
        { action: "page-control", operation: "zoom-reset" },
        {},
      ),
    ).resolves.toEqual({
      spoken: "Zoom one hundred percent.",
    });

    expect(chromeStub.tabs.getZoom).not.toHaveBeenCalled();
    expect(chromeStub.tabs.setZoom).toHaveBeenCalledWith(12, 1);
  });

  it("formats the minimum and maximum feedback levels", () => {
    expect(zoomFeedback(0.25)).toBe("Zoom twenty five percent.");
    expect(zoomFeedback(5)).toBe("Zoom five hundred percent.");
  });
});
