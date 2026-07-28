import { DestinationRegistry } from "@sotto/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import destinations, {
  executeDestinationFollowUp,
  performClipboardWorkflow,
} from "../src/index.js";

const SCREENSHOT = {
  kind: "image",
  mimeType: "image/png",
  dataUrl: "data:image/png;base64,c2NyZWVuc2hvdA==",
} as const;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("image destinations", () => {
  it("dispatches copy as a user-activated clipboard workflow", async () => {
    const registry = new DestinationRegistry(destinations);

    await expect(registry.dispatch("copy", SCREENSHOT)).resolves.toMatchObject({
      spoken: "Screenshot ready. Click Copy in Sotto.",
      workflow: {
        kind: "clipboard-write",
        requiresFocus: true,
        requiresUserActivation: true,
        buttonLabel: "Copy screenshot",
        item: SCREENSHOT,
      },
    });
  });

  it("dispatches Claude with a constrained focus-or-open follow-up", async () => {
    const registry = new DestinationRegistry(destinations);

    await expect(registry.dispatch("claude", SCREENSHOT)).resolves.toMatchObject({
      spoken: "Screenshot ready. Click Copy to open Claude.",
      workflow: {
        buttonLabel: "Copy and open Claude",
        item: SCREENSHOT,
        afterWrite: {
          followUp: {
            kind: "focus-or-open-tab",
            matchPatterns: ["https://claude.ai/*"],
            createUrl: "https://claude.ai/new",
          },
          spoken: "Paste-ready — hit Control V.",
        },
      },
    });
  });
});

describe("clipboard workflow", () => {
  it("writes the PNG and returns the follow-up only after success", async () => {
    const registry = new DestinationRegistry(destinations);
    const result = await registry.dispatch("claude", SCREENSHOT);
    const workflow = result.workflow;
    if (!workflow) throw new Error("Expected a clipboard workflow");

    const png = new Blob(["png"], { type: "image/png" });
    const write = vi.fn().mockResolvedValue(undefined);
    const fetchMock = vi.fn().mockResolvedValue(new Response(png));
    class FakeClipboardItem {
      constructor(readonly items: Record<string, Blob>) {}
    }

    vi.stubGlobal("document", { hasFocus: () => true });
    vi.stubGlobal("navigator", { clipboard: { write } });
    vi.stubGlobal("ClipboardItem", FakeClipboardItem);
    vi.stubGlobal("fetch", fetchMock);

    const completion = await performClipboardWorkflow(workflow);

    expect(fetchMock).toHaveBeenCalledWith(SCREENSHOT.dataUrl);
    expect(write).toHaveBeenCalledOnce();
    const [clipboardItem] = write.mock.calls[0]?.[0] as [FakeClipboardItem];
    expect(clipboardItem.items).toEqual({ "image/png": png });
    expect(completion).toEqual({
      workflowId: workflow.id,
      followUp: {
        kind: "focus-or-open-tab",
        matchPatterns: ["https://claude.ai/*"],
        createUrl: "https://claude.ai/new",
      },
      spoken: "Paste-ready — hit Control V.",
    });
  });
});

describe("Claude follow-up", () => {
  const followUp = {
    kind: "focus-or-open-tab",
    matchPatterns: ["https://claude.ai/*"],
    createUrl: "https://claude.ai/new",
  } as const;

  it("focuses an existing Claude tab and its window", async () => {
    const query = vi.fn().mockResolvedValue([
      { id: 42, windowId: 7, url: "https://claude.ai/chat" },
    ]);
    const updateTab = vi.fn().mockResolvedValue(undefined);
    const updateWindow = vi.fn().mockResolvedValue(undefined);
    const create = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("chrome", {
      tabs: { query, update: updateTab, create },
      windows: { update: updateWindow },
    });

    await executeDestinationFollowUp(followUp);

    expect(query).toHaveBeenCalledWith({ url: ["https://claude.ai/*"] });
    expect(updateTab).toHaveBeenCalledWith(42, { active: true });
    expect(updateWindow).toHaveBeenCalledWith(7, { focused: true });
    expect(create).not.toHaveBeenCalled();
  });

  it("opens a new Claude tab when no existing tab matches", async () => {
    const query = vi.fn().mockResolvedValue([]);
    const updateTab = vi.fn().mockResolvedValue(undefined);
    const updateWindow = vi.fn().mockResolvedValue(undefined);
    const create = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("chrome", {
      tabs: { query, update: updateTab, create },
      windows: { update: updateWindow },
    });

    await executeDestinationFollowUp(followUp);

    expect(create).toHaveBeenCalledWith({
      url: "https://claude.ai/new",
      active: true,
    });
    expect(updateTab).not.toHaveBeenCalled();
    expect(updateWindow).not.toHaveBeenCalled();
  });
});
