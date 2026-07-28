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
  dateTime = "";
  disabled = false;
  hidden = false;
  parent?: FakeElement;
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
  "stt-progress-card",
  "stt-progress",
  "stt-progress-value",
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
  readonly retryWorkflow?: typeof workflow;
} = {}) {
  const elements = Object.fromEntries(
    elementIds.map((id) => [id, new FakeElement()]),
  ) as Record<(typeof elementIds)[number], FakeElement>;
  elements["clipboard-card"].hidden = true;
  const emptyLog = new FakeElement("li");
  emptyLog.className = "empty-log";
  emptyLog.textContent = "No commands yet.";
  elements["action-log"].append(emptyLog);

  let onMessage: ((message: unknown) => void) | undefined;
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
      contains: vi.fn().mockResolvedValue(true),
      request: vi.fn().mockResolvedValue(true),
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

  return { elements, onMessage, sendMessage };
}

afterEach(() => {
  clipboard.perform.mockReset();
  vi.resetModules();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("side-panel screenshot clipboard fallback", () => {
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
    const { elements, onMessage, sendMessage } = await installSidepanel({
      retryWorkflow: workflow,
    });

    onMessage({
      target: "sidepanel",
      type: "screenshot-permission-needed",
      workflow: {
        kind: "screenshot-permission",
        host: "example.com",
        pendingCommand: { action: "screenshot", destination: "claude" },
      },
    });
    await elements["copy-screenshot"].emit("click");

    expect(clipboard.perform).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith({
      target: "worker",
      type: "clipboard-complete",
      completion,
    });
    expect(elements["clipboard-card"].hidden).toBe(true);
  });
});
