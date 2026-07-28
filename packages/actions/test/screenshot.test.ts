import { beforeEach, describe, expect, it, vi } from "vitest";

import screenshot from "../src/screenshot/index.js";
import { chromeTab, installChromeStub } from "./chrome-stub.js";

describe("screenshot action", () => {
  let chromeStub: ReturnType<typeof installChromeStub>;

  beforeEach(() => {
    chromeStub = installChromeStub();
  });

  it("captures the active window and dispatches its image with tab metadata", async () => {
    chromeStub.tabs.query.mockResolvedValue([
      chromeTab({
        id: 7,
        windowId: 3,
        title: "Sotto",
        url: "https://example.test/page",
      }),
    ]);
    chromeStub.tabs.captureVisibleTab.mockResolvedValue(
      "data:image/png;base64,c2NyZWVuc2hvdA==",
    );
    const result = { spoken: "Copied screenshot." };
    const dispatchDestination = vi.fn().mockResolvedValue(result);

    await expect(
      screenshot.execute(
        { action: "screenshot", destination: "copy" },
        { dispatchDestination },
      ),
    ).resolves.toBe(result);

    expect(chromeStub.tabs.query).toHaveBeenCalledWith({
      active: true,
      currentWindow: true,
    });
    expect(chromeStub.tabs.captureVisibleTab).toHaveBeenCalledWith(3, {
      format: "png",
    });
    expect(dispatchDestination).toHaveBeenCalledWith("copy", {
      kind: "image",
      mimeType: "image/png",
      dataUrl: "data:image/png;base64,c2NyZWVuc2hvdA==",
      source: {
        kind: "screenshot",
        tabId: 7,
        title: "Sotto",
        url: "https://example.test/page",
      },
    });
  });

  it("omits unavailable optional tab metadata", async () => {
    chromeStub.tabs.query.mockResolvedValue([chromeTab({ windowId: 4 })]);
    chromeStub.tabs.captureVisibleTab.mockResolvedValue("data:image/png;base64,");
    const dispatchDestination = vi
      .fn()
      .mockResolvedValue({ spoken: "Screenshot ready." });

    await screenshot.execute(
      { action: "screenshot", destination: "claude" },
      { dispatchDestination },
    );

    expect(dispatchDestination).toHaveBeenCalledWith(
      "claude",
      expect.objectContaining({
        source: { kind: "screenshot" },
      }),
    );
  });

  it("requires a destination dispatcher before accessing Chrome", async () => {
    await expect(
      screenshot.execute(
        { action: "screenshot", destination: "copy" },
        {},
      ),
    ).rejects.toThrow(
      "Screenshot requires a destination dispatcher in ActionContext",
    );
    expect(chromeStub.tabs.query).not.toHaveBeenCalled();
  });

  it("fails clearly when no active tab can be captured", async () => {
    chromeStub.tabs.query.mockResolvedValue([]);
    const dispatchDestination = vi.fn();

    await expect(
      screenshot.execute(
        { action: "screenshot", destination: "copy" },
        { dispatchDestination },
      ),
    ).rejects.toThrow("No active tab is available to capture");
    expect(chromeStub.tabs.captureVisibleTab).not.toHaveBeenCalled();
    expect(dispatchDestination).not.toHaveBeenCalled();
  });
});
