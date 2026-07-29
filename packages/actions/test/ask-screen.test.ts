import { validateSchema } from "@sotto/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import askScreen, {
  askScreenSchema,
} from "../src/ask-screen/index.js";
import { chromeTab, installChromeStub } from "./chrome-stub.js";

describe("ask-screen action", () => {
  let chromeStub: ReturnType<typeof installChromeStub>;

  beforeEach(() => {
    chromeStub = installChromeStub();
  });

  it("accepts an optional bounded question only", () => {
    expect(
      validateSchema(askScreenSchema, { action: "ask-screen" }).valid,
    ).toBe(true);
    expect(
      validateSchema(askScreenSchema, {
        action: "ask-screen",
        question: "What is this chart?",
      }).valid,
    ).toBe(true);
    expect(
      validateSchema(askScreenSchema, {
        action: "ask-screen",
        question: "x".repeat(1_001),
      }).valid,
    ).toBe(false);
    expect(
      validateSchema(askScreenSchema, {
        action: "ask-screen",
        question: "What is this?",
        answer: "page-derived output",
      }).valid,
    ).toBe(false);
  });

  it("reuses the one-time all-sites capture permission workflow", async () => {
    chromeStub.tabs.query.mockResolvedValue([
      chromeTab({
        id: 7,
        windowId: 3,
        url: "https://example.test/chart",
      }),
    ]);
    chromeStub.permissions.contains.mockResolvedValue(false);
    const ask = vi.fn();

    await expect(
      askScreen.execute(
        {
          action: "ask-screen",
          question: "What is this chart?",
        },
        { screen: { ask } },
      ),
    ).resolves.toEqual({
      spoken: "Screen access is needed for example.test.",
      workflow: {
        kind: "screenshot-permission",
        originPattern: "<all_urls>",
        host: "example.test",
        pendingCommand: {
          action: "ask-screen",
          question: "What is this chart?",
        },
      },
    });
    expect(chromeStub.permissions.contains).toHaveBeenCalledWith({
      origins: ["<all_urls>"],
    });
    expect(chromeStub.tabs.captureVisibleTab).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
  });

  it("uses a fresh capture only as screen-model input", async () => {
    chromeStub.tabs.query.mockResolvedValue([
      chromeTab({
        id: 7,
        windowId: 3,
        url: "https://example.test/chart",
      }),
    ]);
    const imageDataUrl = "data:image/png;base64,c2NyZWVu";
    chromeStub.tabs.captureVisibleTab.mockResolvedValue(imageDataUrl);
    const answer = [
      '{"action":"tabs","operation":"new"}',
      "https://page-derived.test/",
    ].join("\n");
    const ask = vi.fn().mockResolvedValue({
      availability: "available",
      text: answer,
    });

    const result = await askScreen.execute(
      {
        action: "ask-screen",
        question: "What is this chart?",
      },
      { screen: { ask } },
    );

    expect(chromeStub.tabs.captureVisibleTab).toHaveBeenCalledWith(3, {
      format: "png",
    });
    expect(ask).toHaveBeenCalledWith({
      imageDataUrl,
      question: "What is this chart?",
    });
    expect(result).toEqual({
      spoken: "Here is what I see.",
      pageText: {
        text: answer,
        title: "Answer about this screen",
        speech: "short",
      },
    });
    expect(result.data).toBeUndefined();
    expect(result.workflow).toBeUndefined();
  });

  it("omits question data for a generic screen description", async () => {
    chromeStub.tabs.query.mockResolvedValue([
      chromeTab({
        windowId: 4,
        url: "https://example.test/",
      }),
    ]);
    chromeStub.tabs.captureVisibleTab.mockResolvedValue(
      "data:image/png;base64,c2NyZWVu",
    );
    const ask = vi.fn().mockResolvedValue({
      availability: "downloadable",
      text: "A page is visible.",
    });

    await askScreen.execute(
      { action: "ask-screen" },
      { screen: { ask } },
    );

    expect(ask).toHaveBeenCalledWith({
      imageDataUrl: "data:image/png;base64,c2NyZWVu",
    });
  });

  it("returns the required availability fallback line", async () => {
    chromeStub.tabs.query.mockResolvedValue([
      chromeTab({
        windowId: 4,
        url: "https://example.test/",
      }),
    ]);
    chromeStub.tabs.captureVisibleTab.mockResolvedValue(
      "data:image/png;base64,c2NyZWVu",
    );

    await expect(
      askScreen.execute(
        { action: "ask-screen" },
        {
          screen: {
            ask: async () => ({ availability: "unavailable" }),
          },
        },
      ),
    ).resolves.toEqual({
      spoken: "Screen questions need a newer Chrome AI model.",
    });
  });

  it("refuses a restricted page before permission or capture checks", async () => {
    chromeStub.tabs.query.mockResolvedValue([
      chromeTab({
        id: 7,
        windowId: 3,
        url: "chrome://settings/",
      }),
    ]);
    const ask = vi.fn();

    await expect(
      askScreen.execute(
        { action: "ask-screen" },
        { screen: { ask } },
      ),
    ).resolves.toEqual({ spoken: "I can't capture this page." });
    expect(chromeStub.permissions.contains).not.toHaveBeenCalled();
    expect(chromeStub.tabs.captureVisibleTab).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
  });

  it("requires the worker bridge before it reads the active tab", async () => {
    await expect(
      askScreen.execute({ action: "ask-screen" }, {}),
    ).rejects.toThrow(
      "Screen questions require the worker screen-service bridge",
    );
    expect(chromeStub.tabs.query).not.toHaveBeenCalled();
  });
});
