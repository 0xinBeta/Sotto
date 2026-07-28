import { afterEach, describe, expect, it, vi } from "vitest";

const clipboard = vi.hoisted(() => ({
  perform: vi.fn(),
}));

vi.mock("@sotto/destinations", () => ({
  performClipboardWorkflow: clipboard.perform,
}));

type Listener = (event: Record<string, unknown>) => unknown;

class FakeElement {
  readonly children: Array<FakeElement | FakeText> = [];
  readonly dataset: Record<string, string> = {};
  readonly listeners = new Map<string, Listener[]>();
  className = "";
  checked = false;
  dateTime = "";
  disabled = false;
  hidden = false;
  parent?: FakeElement;
  readonly style: Record<string, string> = {};
  title = "";
  value: string | number = "";
  private copy = "";

  get firstElementChild(): FakeElement | undefined {
    return this.children.find(
      (child): child is FakeElement => child instanceof FakeElement,
    );
  }

  get textContent(): string {
    return (
      this.copy +
      this.children.map((child) => child.textContent).join("")
    );
  }

  set textContent(value: string) {
    this.copy = value;
    this.children.length = 0;
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  append(...children: Array<FakeElement | FakeText>): void {
    for (const child of children) {
      child.parent = this;
      this.children.push(child);
    }
  }

  prepend(child: FakeElement): void {
    child.parent = this;
    this.children.unshift(child);
  }

  querySelector(selector: string): FakeElement | undefined {
    for (const child of this.children) {
      if (!(child instanceof FakeElement)) continue;
      if (
        (selector === "time" && child.tagName === "time") ||
        (selector.startsWith(".") &&
          child.className.split(" ").includes(selector.slice(1)))
      ) {
        return child;
      }
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return undefined;
  }

  remove(): void {
    if (!this.parent) return;
    const index = this.parent.children.indexOf(this);
    if (index >= 0) this.parent.children.splice(index, 1);
  }

  replaceChildren(...children: FakeElement[]): void {
    this.children.length = 0;
    this.append(...children);
  }

  setAttribute(): void {}
  setPointerCapture(): void {}
  releasePointerCapture(): void {}

  async emit(type: string): Promise<void> {
    const event = {
      preventDefault: vi.fn(),
      pointerId: 1,
      key: "",
      repeat: false,
    };
    await Promise.all(
      (this.listeners.get(type) ?? []).map((listener) =>
        Promise.resolve(listener(event)),
      ),
    );
  }

  constructor(readonly tagName = "div") {}
}

class FakeText {
  parent?: FakeElement;

  constructor(readonly textContent: string) {}
}

const elementIds = [
  "status-chip",
  "status-label",
  "capture-setup",
  "enable-capture",
  "setup-grant-mic",
  "setup-prepare-nano",
  "onboarding",
  "onboarding-title",
  "onboarding-copy",
  "prepare-nano",
  "transcript",
  "listening-mark",
  "listen-button",
  "listen-label",
  "mic-meter",
  "mic-meter-fill",
  "shortcut-label",
  "grant-mic",
  "command-form",
  "command-input",
  "clipboard-card",
  "clipboard-copy",
  "copy-screenshot",
  "action-log",
  "clear-log",
  "nano-progress-card",
  "nano-progress",
  "nano-progress-value",
  "nano-progress-label",
  "stt-progress-card",
  "stt-progress",
  "stt-progress-value",
  "premium-voice-card",
  "premium-voice-state",
  "premium-voice-copy",
  "download-premium-voice",
  "premium-voice-enabled",
  "premium-progress-card",
  "premium-progress",
  "premium-progress-value",
  "premium-progress-label",
  "premium-stt-card",
  "premium-stt-state",
  "premium-stt-copy",
  "download-premium-stt",
  "premium-stt-enabled",
  "premium-stt-progress-card",
  "premium-stt-progress",
  "premium-stt-progress-value",
  "premium-stt-progress-label",
  "page-text-card",
  "page-text-title",
  "page-text-output",
  "close-page-text",
  "reading-progress",
  "notes-list",
  "export-notes",
  "reminder-banner",
] as const;

const workflow = {
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
} as const;

const completion = {
  workflowId: workflow.id,
  followUp: workflow.afterWrite.followUp,
  spoken: workflow.afterWrite.spoken,
};

async function installSidepanel(options: {
  readonly capturePermissionGranted?: boolean;
  readonly retryWorkflow?: typeof workflow;
} = {}) {
  const elements = Object.fromEntries(
    elementIds.map((id) => [id, new FakeElement()]),
  ) as Record<(typeof elementIds)[number], FakeElement>;
  elements["capture-setup"].hidden = true;
  elements["clipboard-card"].hidden = true;
  const emptyLog = new FakeElement("li");
  emptyLog.className = "empty-log";
  emptyLog.textContent = "No commands yet.";
  elements["action-log"].append(emptyLog);

  let onMessage: ((message: unknown) => void) | undefined;
  const requestPermission = vi.fn().mockResolvedValue(true);
  const sendMessage = vi.fn().mockImplementation(
    async (message: { readonly type?: string }) => {
      if (message.type === "retry-screenshot") {
        return {
          ok: true,
          value: options.retryWorkflow
            ? { spoken: "Screenshot ready.", workflow: options.retryWorkflow }
            : undefined,
        };
      }
      return { ok: true };
    },
  );

  vi.stubGlobal("document", {
    hasFocus: vi.fn(() => true),
    querySelector: vi.fn((selector: string) =>
      selector.startsWith("#") ? elements[selector.slice(1) as keyof typeof elements] : undefined,
    ),
    createElement: vi.fn((tagName: string) => new FakeElement(tagName)),
    createTextNode: vi.fn((text: string) => new FakeText(text)),
  });
  vi.stubGlobal("window", {
    clearTimeout,
    setTimeout,
  });
  vi.stubGlobal("chrome", {
    runtime: {
      sendMessage,
      onMessage: {
        addListener: vi.fn((listener) => {
          onMessage = listener;
        }),
      },
    },
    permissions: {
      contains: vi
        .fn()
        .mockResolvedValue(options.capturePermissionGranted ?? true),
      request: requestPermission,
    },
    commands: {
      getAll: vi.fn().mockResolvedValue([
        { name: "toggle-sotto", shortcut: "Alt+S" },
      ]),
    },
  });

  await import("../src/sidepanel.js");
  await Promise.resolve();
  sendMessage.mockClear();
  if (!onMessage) throw new Error("Side-panel message listener was not installed");

  return { elements, onMessage, requestPermission, sendMessage };
}

afterEach(() => {
  clipboard.perform.mockReset();
  vi.resetModules();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("side-panel screenshot clipboard fallback", () => {
  it("shows OS fallback while absent and enables the default-on premium toggle when ready", async () => {
    const { elements, onMessage } = await installSidepanel();

    onMessage({
      target: "sidepanel",
      type: "premium-tts-state",
      state: "absent",
      enabled: false,
    });
    expect(elements["premium-voice-copy"].textContent).toContain(
      "operating system voice instantly",
    );
    expect(elements["download-premium-voice"].hidden).toBe(false);
    expect(elements["premium-voice-enabled"].disabled).toBe(true);

    onMessage({
      target: "sidepanel",
      type: "premium-tts-state",
      state: "ready",
      enabled: true,
      backend: "webgpu",
    });
    expect(elements["download-premium-voice"].hidden).toBe(true);
    expect(elements["premium-voice-enabled"].checked).toBe(true);
    expect(elements["premium-voice-enabled"].disabled).toBe(false);
    expect(elements["premium-voice-copy"].textContent).toContain("WEBGPU");
  });

  it("renders the hardware-selected speech tier, progress, diagnostics, and persisted toggle request", async () => {
    const { elements, onMessage, sendMessage } = await installSidepanel();

    onMessage({
      target: "sidepanel",
      type: "premium-stt-state",
      state: "not-downloaded",
      enabled: false,
      downloaded: false,
      resident: false,
      tier: "parakeet",
      backend: "webgpu",
    });
    expect(elements["premium-stt-copy"].textContent).toContain("409 MB");
    expect(elements["download-premium-stt"].textContent).toContain("409 MB");

    onMessage({
      target: "sidepanel",
      type: "model-progress",
      model: "premium-stt",
      progress: 0.5,
      status: "downloading",
      file: "encoder-model.int4.onnx",
    });
    expect(elements["premium-stt-progress-value"].textContent).toBe("50%");
    expect(elements["premium-stt-progress-label"].textContent).toContain(
      "encoder-model.int4.onnx",
    );

    onMessage({
      target: "sidepanel",
      type: "premium-stt-state",
      state: "active",
      enabled: true,
      downloaded: true,
      resident: true,
      tier: "moonshine-base",
      backend: "wasm",
    });
    expect(elements["premium-stt-copy"].textContent).toContain("63 MB");
    expect(elements["premium-stt-enabled"].checked).toBe(true);
    expect(elements["premium-stt-enabled"].disabled).toBe(false);

    elements["premium-stt-enabled"].checked = false;
    await elements["premium-stt-enabled"].emit("change");
    expect(sendMessage).toHaveBeenCalledWith({
      target: "worker",
      type: "set-premium-stt-enabled",
      enabled: false,
    });

    onMessage({
      target: "sidepanel",
      type: "stt-diagnostic",
      diagnostic: "vad-rejected",
      message: "Speech was too short or quiet.",
    });
    expect(elements.transcript.textContent).toBe(
      "Speech was too short or quiet.",
    );
    expect(elements.transcript.dataset.diagnostic).toBe("vad-rejected");
  });

  it("shows idle, listening, and speech meter states", async () => {
    const { elements, onMessage } = await installSidepanel();

    expect(elements["mic-meter"].dataset.state).toBe("idle");
    expect(elements["mic-meter-fill"].style.transform).toBe("scaleX(0)");

    onMessage({
      target: "sidepanel",
      type: "listening-state",
      listening: true,
    });
    onMessage({
      target: "sidepanel",
      type: "mic-level",
      level: 0.42,
    });
    expect(elements["mic-meter"].dataset.state).toBe("listening");
    expect(elements["mic-meter-fill"].style.transform).toBe("scaleX(0.42)");

    onMessage({ target: "sidepanel", type: "speech-start" });
    expect(elements["mic-meter"].dataset.state).toBe("speech");

    onMessage({ target: "sidepanel", type: "speech-end" });
    expect(elements["mic-meter"].dataset.state).toBe("listening");

    onMessage({
      target: "sidepanel",
      type: "listening-state",
      listening: false,
    });
    onMessage({
      target: "sidepanel",
      type: "mic-level",
      level: 0.9,
    });
    expect(elements["mic-meter"].dataset.state).toBe("idle");
    expect(elements["mic-meter-fill"].style.transform).toBe("scaleX(0)");
  });

  it("shows first-run capture setup and hides it live after the one-time grant", async () => {
    const { elements, requestPermission } = await installSidepanel({
      capturePermissionGranted: false,
    });

    await vi.waitFor(() => {
      expect(elements["capture-setup"].hidden).toBe(false);
    });
    await elements["enable-capture"].emit("click");

    expect(requestPermission).toHaveBeenCalledWith({
      origins: ["<all_urls>"],
    });
    expect(elements["capture-setup"].hidden).toBe(true);
  });

  it("renders page-model and note text as inert textContent", async () => {
    const { elements, onMessage } = await installSidepanel();
    const untrusted = '<img src=x onerror="chrome.runtime.sendMessage(1)">';

    onMessage({
      target: "sidepanel",
      type: "page-text",
      title: "Answer",
      text: untrusted,
    });
    onMessage({
      target: "sidepanel",
      type: "notes-updated",
      notes: [
        {
          id: "note-1",
          body: untrusted,
          createdAt: "2026-07-28T12:00:00.000Z",
          updatedAt: "2026-07-28T12:00:00.000Z",
        },
      ],
    });

    expect(elements["page-text-output"].textContent).toBe(untrusted);
    expect(elements["page-text-card"].hidden).toBe(false);
    expect(elements["notes-list"].firstElementChild?.textContent).toContain(
      untrusted,
    );
  });

  it("rejects malformed v0.2 panel payloads before rendering", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { elements, onMessage } = await installSidepanel();

    onMessage({
      target: "sidepanel",
      type: "page-text",
      title: "Answer",
      text: { hostile: true },
    });
    onMessage({
      target: "sidepanel",
      type: "notes-updated",
      notes: "not-an-array",
    });
    onMessage({
      target: "sidepanel",
      type: "screenshot-permission-needed",
      workflow: {
        kind: "screenshot-permission",
        host: "example.com",
        pendingCommand: { action: "screenshot", destination: "copy" },
      },
    });

    expect(elements["page-text-output"].textContent).toBe("");
    expect(elements["notes-list"].children).toEqual([]);
    expect(elements["clipboard-card"].hidden).toBe(true);
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it("automatically writes on receipt without showing the copy card", async () => {
    clipboard.perform.mockResolvedValue(completion);
    const { elements, onMessage, sendMessage } = await installSidepanel();

    onMessage({ target: "sidepanel", type: "screenshot-ready", workflow });

    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith({
        target: "worker",
        type: "clipboard-complete",
        completion,
      });
    });
    expect(clipboard.perform).toHaveBeenCalledOnce();
    expect(elements["clipboard-card"].hidden).toBe(true);
  });

  it("shows the copy card and honest focus message after an automatic rejection", async () => {
    clipboard.perform
      .mockRejectedValueOnce(
        new DOMException("Document is not focused", "NotAllowedError"),
      )
      .mockResolvedValueOnce(completion);
    const { elements, onMessage, sendMessage } = await installSidepanel();

    onMessage({ target: "sidepanel", type: "screenshot-ready", workflow });

    await vi.waitFor(() => {
      expect(elements["clipboard-card"].hidden).toBe(false);
    });
    const message =
      "Chrome blocks clipboard writes while Sotto and the page are both unfocused — click Copy.";
    expect(elements["clipboard-copy"].textContent).toBe(message);
    expect(elements["copy-screenshot"].textContent).toBe(workflow.buttonLabel);
    expect(elements["action-log"].textContent).toContain(
      `copy screenshot → ${message}`,
    );

    await elements["copy-screenshot"].emit("click");
    expect(clipboard.perform).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenCalledWith({
      target: "worker",
      type: "clipboard-complete",
      completion,
    });
  });

  it("clears a successful automatic workflow so a later click cannot write twice", async () => {
    clipboard.perform.mockResolvedValue(completion);
    const { elements, onMessage, sendMessage } = await installSidepanel();

    onMessage({ target: "sidepanel", type: "screenshot-ready", workflow });
    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "clipboard-complete" }),
      );
    });
    await elements["copy-screenshot"].emit("click");

    expect(clipboard.perform).toHaveBeenCalledOnce();
  });

  it("automatically attempts a workflow returned by the permission retry", async () => {
    clipboard.perform.mockResolvedValue(completion);
    const {
      elements,
      onMessage,
      requestPermission,
      sendMessage,
    } = await installSidepanel({
      retryWorkflow: workflow,
    });

    onMessage({
      target: "sidepanel",
      type: "screenshot-permission-needed",
      workflow: {
        kind: "screenshot-permission",
        originPattern: "<all_urls>",
        host: "example.com",
        pendingCommand: { action: "screenshot", destination: "claude" },
      },
    });
    await elements["copy-screenshot"].emit("click");

    expect(requestPermission).toHaveBeenCalledWith({
      origins: ["<all_urls>"],
    });
    expect(clipboard.perform).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith({
      target: "worker",
      type: "clipboard-complete",
      completion,
    });
    expect(elements["clipboard-card"].hidden).toBe(true);
  });
});
