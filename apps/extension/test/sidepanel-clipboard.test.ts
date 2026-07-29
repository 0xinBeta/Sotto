import { afterEach, describe, expect, it, vi } from "vitest";

const clipboard = vi.hoisted(() => ({
  perform: vi.fn(),
}));

vi.mock("@sotto/destinations", () => ({
  performClipboardWorkflow: clipboard.perform,
}));

type Listener = (event: Record<string, unknown>) => unknown;

class FakeElement {
  readonly attributes: Record<string, string> = {};
  readonly children: Array<FakeElement | FakeText> = [];
  readonly dataset: Record<string, string> = {};
  readonly listeners = new Map<string, Listener[]>();
  className = "";
  checked = false;
  dateTime = "";
  disabled = false;
  hidden = false;
  open = false;
  parent?: FakeElement;
  readonly style: Record<string, string> = {};
  textUpdateCount = 0;
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
    this.textUpdateCount += 1;
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

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }
  setPointerCapture(): void {}
  releasePointerCapture(): void {}
  scrollIntoView = vi.fn();

  async emit(
    type: string,
    values: Record<string, unknown> = {},
  ): Promise<void> {
    const event = {
      preventDefault: vi.fn(),
      pointerId: 1,
      key: "",
      repeat: false,
      ...values,
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
  "pipeline-error",
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
  "action-log-announcer",
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
  "premium-voice-picker",
  "premium-voice-options",
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
  "speech-rate",
  "speech-rate-value",
  "speech-volume",
  "speech-volume-value",
  "page-text-card",
  "page-text-title",
  "page-text-output",
  "close-page-text",
  "reading-progress",
  "reading-controls",
  "pause-reading",
  "skip-reading",
  "notes-list",
  "export-notes",
  "reminder-banner",
  "command-reference",
  "command-reference-list",
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
  readonly speechSettings?: {
    readonly rate: number;
    readonly volume: number;
  };
} = {}) {
  const elements = Object.fromEntries(
    elementIds.map((id) => [id, new FakeElement()]),
  ) as Record<(typeof elementIds)[number], FakeElement>;
  elements["capture-setup"].hidden = true;
  elements["clipboard-card"].hidden = true;
  elements["reading-controls"].hidden = true;
  const emptyLog = new FakeElement("li");
  emptyLog.className = "empty-log";
  emptyLog.textContent = "No commands yet.";
  elements["action-log"].append(emptyLog);

  let onMessage: ((message: unknown) => void) | undefined;
  const documentListeners = new Map<string, Listener[]>();
  const requestPermission = vi.fn().mockResolvedValue(true);
  const sendMessage = vi.fn().mockImplementation(
    async (message: { readonly type?: string }) => {
      if (message.type === "get-speech-settings") {
        return {
          ok: true,
          value: options.speechSettings,
        };
      }
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
    addEventListener: vi.fn((type: string, listener: Listener) => {
      const listeners = documentListeners.get(type) ?? [];
      listeners.push(listener);
      documentListeners.set(type, listeners);
    }),
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

  const emitDocument = async (
    type: string,
    values: Record<string, unknown> = {},
  ): Promise<void> => {
    const event = {
      preventDefault: vi.fn(),
      key: "",
      repeat: false,
      ...values,
    };
    await Promise.all(
      (documentListeners.get(type) ?? []).map((listener) =>
        Promise.resolve(listener(event)),
      ),
    );
  };

  return {
    elements,
    emitDocument,
    onMessage,
    requestPermission,
    sendMessage,
  };
}

afterEach(() => {
  vi.useRealTimers();
  clipboard.perform.mockReset();
  vi.resetModules();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("side-panel screenshot clipboard fallback", () => {
  it("shows and persists bounded speech slider values", async () => {
    const { elements, sendMessage } = await installSidepanel({
      speechSettings: { rate: 1.3, volume: 0.55 },
    });
    await vi.waitFor(() =>
      expect(elements["speech-rate-value"].textContent).toBe("1.3×")
    );
    expect(elements["speech-volume-value"].textContent).toBe("55%");
    expect(elements["speech-rate"].getAttribute("aria-valuetext")).toBe(
      "1.3 times",
    );
    expect(elements["speech-volume"].getAttribute("aria-valuetext")).toBe(
      "55 percent",
    );

    elements["speech-rate"].value = "8";
    await elements["speech-rate"].emit("input");
    await vi.waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith({
        target: "worker",
        type: "set-speech-settings",
        rate: 2,
        volume: 0.55,
      })
    );
    expect(elements["speech-rate-value"].textContent).toBe("2.0×");

    elements["speech-volume"].value = "-2";
    await elements["speech-volume"].emit("input");
    await vi.waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith({
        target: "worker",
        type: "set-speech-settings",
        rate: 2,
        volume: 0,
      })
    );
    expect(elements["speech-volume-value"].textContent).toBe("0%");
  });

  it("shows OS fallback while absent and enables the default-on premium toggle when ready", async () => {
    const { elements, onMessage, sendMessage } = await installSidepanel();

    onMessage({
      target: "sidepanel",
      type: "premium-tts-state",
      state: "absent",
      enabled: false,
      voice: "af_heart",
    });
    expect(elements["premium-voice-copy"].textContent).toContain(
      "operating system voice instantly",
    );
    expect(elements["download-premium-voice"].hidden).toBe(false);
    expect(elements["premium-voice-enabled"].disabled).toBe(true);

    onMessage({
      target: "sidepanel",
      type: "premium-tts-state",
      state: "error",
      enabled: false,
      voice: "af_heart",
    });
    expect(elements["download-premium-voice"].textContent).toBe(
      "Retry voice download",
    );
    expect(elements["download-premium-voice"].disabled).toBe(false);
    await elements["download-premium-voice"].emit("click");
    expect(sendMessage).toHaveBeenCalledWith({
      target: "worker",
      type: "prepare-premium-tts",
    });

    onMessage({
      target: "sidepanel",
      type: "premium-tts-state",
      state: "ready",
      enabled: true,
      voice: "af_heart",
      backend: "webgpu",
    });
    expect(elements["download-premium-voice"].hidden).toBe(true);
    expect(elements["premium-voice-enabled"].checked).toBe(true);
    expect(elements["premium-voice-enabled"].disabled).toBe(false);
    expect(elements["premium-voice-copy"].textContent).toContain("WEBGPU");
  });

  it("shows every voice preview and logs one short preview failure", async () => {
    const { elements, onMessage, sendMessage } = await installSidepanel();
    onMessage({
      target: "sidepanel",
      type: "premium-tts-state",
      state: "ready",
      enabled: true,
      voice: "af_heart",
      backend: "wasm",
    });

    const options = elements["premium-voice-options"].children
      .filter((child): child is FakeElement => child instanceof FakeElement);
    expect(elements["premium-voice-picker"].hidden).toBe(false);
    expect(options).toHaveLength(28);
    expect(
      options.every((row) =>
        row.children.some(
          (child) =>
            child instanceof FakeElement &&
            child.className === "premium-voice-preview",
        )
      ),
    ).toBe(true);

    sendMessage.mockImplementation(
      async (message: { readonly type?: string }) =>
        message.type === "preview-premium-tts-voice"
          ? {
              ok: false,
              error: { message: "Voice download failed" },
            }
          : { ok: true },
    );
    const emmaRow = options.find((row) =>
      row.textContent.includes("Emma")
    );
    const preview = emmaRow?.children.find(
      (child): child is FakeElement =>
        child instanceof FakeElement &&
        child.className === "premium-voice-preview",
    );
    if (!preview) throw new Error("Emma preview was not rendered");

    await preview.emit("click");
    await vi.waitFor(() =>
      expect(elements["action-log"].textContent).toContain(
        "Voice preview failed.",
      ),
    );

    expect(elements["action-log"].children).toHaveLength(1);
    expect(sendMessage).toHaveBeenCalledWith({
      target: "worker",
      type: "preview-premium-tts-voice",
      voice: "bf_emma",
    });
    const selected = options
      .flatMap((row) => row.children)
      .find(
        (child): child is FakeElement =>
          child instanceof FakeElement &&
          child.value === "af_heart",
      );
    expect(selected?.checked).toBe(true);
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
      loaded: 204_612_558,
      total: 409_225_115,
    });
    expect(elements["premium-stt-progress-value"].textContent).toBe(
      "205 of 409 MB",
    );
    expect(elements["premium-stt-progress-label"].textContent).toContain(
      "encoder-model.int4.onnx",
    );

    onMessage({
      target: "sidepanel",
      type: "premium-stt-state",
      state: "error",
      enabled: false,
      downloaded: false,
      resident: false,
      resumable: true,
      tier: "parakeet",
      backend: "webgpu",
    });
    expect(elements["download-premium-stt"].textContent).toBe(
      "Resume download",
    );
    expect(elements["download-premium-stt"].disabled).toBe(false);
    await elements["download-premium-stt"].emit("click");
    expect(sendMessage).toHaveBeenCalledWith({
      target: "worker",
      type: "prepare-premium-stt",
    });
    expect(elements["download-premium-stt"].disabled).toBe(true);
    expect(elements["premium-stt-progress-value"].textContent).toBe(
      "205 of 409 MB",
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

  it("updates the meter for assistive technology at most twice per second", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T12:00:00.000Z"));
    const { elements, onMessage } = await installSidepanel();

    onMessage({
      target: "sidepanel",
      type: "listening-state",
      listening: true,
    });
    onMessage({ target: "sidepanel", type: "mic-level", level: 0.2 });
    expect(elements["mic-meter"].getAttribute("aria-valuenow")).toBe("20");

    vi.advanceTimersByTime(100);
    onMessage({ target: "sidepanel", type: "mic-level", level: 0.8 });
    expect(elements["mic-meter-fill"].style.transform).toBe("scaleX(0.8)");
    expect(elements["mic-meter"].getAttribute("aria-valuenow")).toBe("20");

    vi.advanceTimersByTime(399);
    expect(elements["mic-meter"].getAttribute("aria-valuenow")).toBe("20");
    vi.advanceTimersByTime(1);
    expect(elements["mic-meter"].getAttribute("aria-valuenow")).toBe("80");
  });

  it("stops listening and reading when Escape is pressed in the panel", async () => {
    const {
      elements,
      emitDocument,
      onMessage,
      sendMessage,
    } = await installSidepanel();
    onMessage({
      target: "sidepanel",
      type: "listening-state",
      listening: true,
    });
    onMessage({
      target: "sidepanel",
      type: "reading-progress",
      current: 4,
      total: 10,
    });

    await emitDocument("keydown", { key: "Escape" });

    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith({
        target: "worker",
        type: "stop-listening",
      });
      expect(sendMessage).toHaveBeenCalledWith({
        target: "worker",
        type: "stop-reading",
      });
    });
    expect(elements["listen-button"].getAttribute("aria-pressed")).toBe(
      "false",
    );
    expect(elements["reading-progress"].hidden).toBe(true);
    expect(elements["reading-controls"].hidden).toBe(true);
  });

  it("shows playback controls only during a read", async () => {
    const { elements, onMessage, sendMessage } = await installSidepanel();
    expect(elements["reading-controls"].hidden).toBe(true);

    onMessage({
      target: "sidepanel",
      type: "reading-state",
      active: true,
      paused: false,
    });
    expect(elements["reading-controls"].hidden).toBe(false);
    expect(elements["pause-reading"].textContent).toBe("Pause");
    expect(elements["action-log-announcer"].textContent).toBe(
      "Reading active.",
    );

    await elements["pause-reading"].emit("click");
    expect(sendMessage).toHaveBeenCalledWith({
      target: "worker",
      type: "playback-control",
      operation: "pause",
    });

    onMessage({
      target: "sidepanel",
      type: "reading-state",
      active: true,
      paused: true,
    });
    expect(elements["pause-reading"].textContent).toBe("Resume");
    expect(elements["action-log-announcer"].textContent).toBe(
      "Reading paused.",
    );
    await elements["pause-reading"].emit("click");
    await elements["skip-reading"].emit("click");
    expect(sendMessage).toHaveBeenCalledWith({
      target: "worker",
      type: "playback-control",
      operation: "resume",
    });
    expect(sendMessage).toHaveBeenCalledWith({
      target: "worker",
      type: "playback-control",
      operation: "skip",
    });

    onMessage({
      target: "sidepanel",
      type: "reading-state",
      active: false,
      paused: false,
    });
    expect(elements["reading-controls"].hidden).toBe(true);
    expect(elements["reading-progress"].hidden).toBe(true);
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

  it("opens and scrolls to the command reference on request", async () => {
    const { elements, onMessage } = await installSidepanel();

    onMessage({
      target: "sidepanel",
      type: "show-command-reference",
    });

    expect(elements["command-reference"].open).toBe(true);
    expect(
      elements["command-reference"].scrollIntoView,
    ).toHaveBeenCalledWith({ block: "start" });
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

  it("keeps log deduplication and replaces the timing line", async () => {
    const { elements, onMessage } = await installSidepanel();
    const baseMessage = {
      target: "sidepanel",
      type: "action-log",
      heard: "open calendar",
      did: "Opened Calendar.",
    } as const;

    onMessage({
      ...baseMessage,
      timings: {
        input: "voice",
        sttMs: 420,
        parseMs: 310,
        actionMs: 45,
        voiceMs: 380,
      },
    });
    onMessage({
      ...baseMessage,
      timings: {
        input: "typed",
        parseMs: 500,
        actionMs: 500,
        voiceMs: 1_000,
      },
    });

    const newest = elements["action-log"].firstElementChild;
    expect(elements["action-log"].children).toHaveLength(1);
    expect(newest?.querySelector(".log-count")?.textContent).toBe("×2");
    expect(newest?.querySelector(".log-timing")?.textContent).toBe(
      "typed · parse 500ms · act 500ms · voice 1000ms · total 2.0s",
    );
    expect(newest?.querySelector(".log-timing")?.dataset.tone).toBe("amber");
    expect(elements["action-log-announcer"].textUpdateCount).toBe(2);
    expect(elements["action-log-announcer"].textContent).toBe(
      "open calendar. Opened Calendar. Repeated 2 times.",
    );
  });

  it("announces pipeline errors through the alert region only", async () => {
    const { elements, onMessage } = await installSidepanel();

    onMessage({
      target: "sidepanel",
      type: "pipeline-error",
      message: "The speech model could not start.",
    });

    expect(elements["pipeline-error"].textContent).toBe(
      "The speech model could not start.",
    );
    expect(elements["action-log-announcer"].textContent).toBe("");
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
