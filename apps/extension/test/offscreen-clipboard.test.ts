import type { ClipboardWorkflow } from "@sotto/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { performOffscreenClipboardWorkflow } from "../src/offscreen-clipboard.js";

const WORKFLOW: ClipboardWorkflow = {
  kind: "clipboard-write",
  id: "clipboard-test",
  requiresFocus: true,
  requiresUserActivation: true,
  buttonLabel: "Copy and open Claude",
  item: {
    kind: "image",
    mimeType: "image/png",
    dataUrl: "data:image/png;base64,c2NyZWVuc2hvdA==",
  },
  afterWrite: {
    followUp: {
      kind: "focus-or-open-tab",
      matchPatterns: ["https://claude.ai/*"],
      createUrl: "https://claude.ai/new",
    },
    spoken: "Paste-ready — hit Control V.",
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function installImageDocument(execCommand: ReturnType<typeof vi.fn>) {
  let loadListener: EventListener | undefined;
  const frame = {
    src: "",
    contentDocument: {
      contentType: "image/png",
      execCommand,
    },
    style: { cssText: "" },
    setAttribute: vi.fn(),
    addEventListener: vi.fn(
      (type: string, listener: EventListenerOrEventListenerObject) => {
        if (type === "load") {
          loadListener =
            typeof listener === "function"
              ? listener
              : (event) => listener.handleEvent(event);
        }
      },
    ),
    remove: vi.fn(),
  };
  const append = vi.fn(() => {
    loadListener?.({} as Event);
  });
  const createElement = vi.fn((name: string) => {
    if (name !== "iframe") throw new Error(`Unexpected element: ${name}`);
    return frame;
  });

  vi.stubGlobal("document", {
    body: { append },
    createElement,
  });
  const createObjectURL = vi
    .spyOn(URL, "createObjectURL")
    .mockReturnValue("blob:chrome-extension://sotto/screenshot");
  const revokeObjectURL = vi
    .spyOn(URL, "revokeObjectURL")
    .mockImplementation(() => undefined);

  return {
    append,
    createElement,
    createObjectURL,
    execCommand,
    frame,
    revokeObjectURL,
  };
}

describe("offscreen clipboard workflow", () => {
  it("copies a blob-backed PNG image document without navigator.clipboard", async () => {
    const png = new Blob(["png"], { type: "image/png" });
    const fetchMock = vi.fn().mockResolvedValue(new Response(png));
    const dom = installImageDocument(vi.fn().mockReturnValue(true));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("navigator", {});

    await expect(
      performOffscreenClipboardWorkflow(WORKFLOW),
    ).resolves.toEqual({
      workflowId: "clipboard-test",
      followUp: WORKFLOW.afterWrite?.followUp,
      spoken: "Paste-ready — hit Control V.",
    });

    expect(fetchMock).toHaveBeenCalledWith(WORKFLOW.item.dataUrl);
    expect(dom.createObjectURL).toHaveBeenCalledWith(png);
    expect(dom.append).toHaveBeenCalledWith(dom.frame);
    expect(dom.execCommand).toHaveBeenCalledWith("copy");
    expect(dom.frame.remove).toHaveBeenCalledOnce();
    expect(dom.revokeObjectURL).toHaveBeenCalledWith(
      "blob:chrome-extension://sotto/screenshot",
    );
  });

  it("throws and cleans up when Chrome rejects execCommand", async () => {
    const png = new Blob(["png"], { type: "image/png" });
    const dom = installImageDocument(vi.fn().mockReturnValue(false));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(png)),
    );

    await expect(
      performOffscreenClipboardWorkflow(WORKFLOW),
    ).rejects.toMatchObject({
      name: "NotAllowedError",
      message: "Chrome rejected the automatic image copy",
    });

    expect(dom.frame.remove).toHaveBeenCalledOnce();
    expect(dom.revokeObjectURL).toHaveBeenCalledOnce();
  });
});
