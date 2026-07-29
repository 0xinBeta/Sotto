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
  files?: readonly {
    readonly size: number;
    text(): Promise<string>;
  }[];
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

  get classList(): { toggle(name: string, force?: boolean): boolean } {
    return {
      toggle: (name, force) => {
        const names = new Set(this.className.split(/\s+/u).filter(Boolean));
        const add = force ?? !names.has(name);
        if (add) names.add(name);
        else names.delete(name);
        this.className = [...names].join(" ");
        return add;
      },
    };
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

  removeAttribute(name: string): void {
    delete this.attributes[name];
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }
  setPointerCapture(): void {}
  releasePointerCapture(): void {}
  click = vi.fn();
  focus = vi.fn();
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
  "wake-word-indicator",
  "wake-word-indicator-label",
  "quiet-mode-control",
  "quiet-mode",
  "quiet-mode-label",
  "pipeline-error",
  "setup-view",
  "setup-list",
  "setup-complete",
  "dismiss-setup",
  "setup-microphone",
  "setup-microphone-icon",
  "setup-microphone-state",
  "setup-capture",
  "setup-capture-icon",
  "setup-capture-state",
  "setup-nano",
  "setup-nano-icon",
  "setup-nano-state",
  "setup-premium",
  "setup-premium-icon",
  "setup-premium-state",
  "enable-capture",
  "setup-grant-mic",
  "setup-prepare-nano",
  "setup-download-premium",
  "transcript",
  "listening-mark",
  "listen-button",
  "listen-label",
  "guided-demo-chip",
  "guided-demo-text",
  "dismiss-guided-demo",
  "guided-demo-announcer",
  "mic-meter",
  "mic-meter-fill",
  "shortcut-label",
  "read-page-shortcut-label",
  "grant-mic",
  "command-form",
  "command-input",
  "dictation-card",
  "dictation-copy",
  "resume-dictation",
  "clipboard-card",
  "clipboard-copy",
  "copy-screenshot",
  "action-log",
  "action-log-announcer",
  "clear-log",
  "live-transcript-preview-setting",
  "live-transcript-preview",
  "wake-word-enabled",
  "wake-word-progress-card",
  "wake-word-progress",
  "wake-word-progress-value",
  "wake-word-progress-label",
  "session-history-enabled",
  "session-history-panel",
  "session-history-list",
  "clear-session-history",
  "command-alias-count",
  "add-command-alias",
  "command-alias-phrase-form",
  "command-alias-phrase",
  "command-alias-phrase-instruction",
  "use-command-alias-phrase",
  "speak-command-alias-phrase",
  "cancel-command-alias-phrase",
  "command-alias-target",
  "command-alias-target-phrase",
  "cancel-command-alias-target",
  "command-alias-confirm",
  "command-alias-confirm-phrase",
  "command-alias-confirm-command",
  "save-command-alias",
  "cancel-command-alias-confirm",
  "command-alias-list",
  "command-alias-status",
  "latency-readout",
  "latency-summary",
  "latency-details",
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
  "speech-language-setting",
  "speech-language",
  "speech-language-fixed",
  "speech-language-note",
  "models-list",
  "models-total",
  "speech-rate",
  "speech-rate-value",
  "speech-volume",
  "speech-volume-value",
  "response-verbosity",
  "blocked-site-form",
  "blocked-site-input",
  "add-blocked-site",
  "block-current-site",
  "blocked-sites-list",
  "blocked-sites-status",
  "copy-diagnostic-report",
  "export-settings-backup",
  "choose-settings-backup",
  "settings-backup-file",
  "settings-backup-status",
  "settings-backup-confirm",
  "settings-backup-confirm-copy",
  "confirm-settings-import",
  "cancel-settings-import",
  "page-text-card",
  "page-text-title",
  "page-text-output",
  "reader-text-output",
  "reading-text-output",
  "close-page-text",
  "reading-progress",
  "reader-actions",
  "read-reader",
  "reading-controls",
  "pause-reading",
  "skip-reading",
  "notes-list",
  "notes-search",
  "note-tag-filters",
  "export-notes",
  "notes-count",
  "reminders-list",
  "reminders-count",
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
  readonly quietMode?: boolean;
  readonly retryWorkflow?: typeof workflow;
  readonly reducedMotion?: boolean;
  readonly backupPreview?: {
    readonly valid: boolean;
    readonly noteCount?: number;
    readonly aliasCount?: number;
    readonly droppedAliasCount?: number;
  };
  readonly backupImport?: {
    readonly valid: boolean;
    readonly addedNoteCount?: number;
    readonly aliasCount?: number;
    readonly droppedAliasCount?: number;
  };
  readonly aliasState?: {
    readonly aliases: readonly {
      readonly phrase: string;
      readonly command: Record<string, unknown>;
    }[];
    readonly capture:
      | { readonly stage: "idle" | "phrase" }
      | { readonly stage: "target"; readonly phrase: string }
      | {
          readonly stage: "confirm";
          readonly phrase: string;
          readonly command: Record<string, unknown>;
        };
    readonly message?: string;
  };
  readonly speechSettings?: {
    readonly rate: number;
    readonly volume: number;
    readonly verbosity: "normal" | "brief";
  };
  readonly blockedSites?: {
    readonly hostnames: readonly string[];
    readonly currentHostname?: string;
  };
  readonly sessionHistory?: {
    readonly enabled: boolean;
    readonly entries: readonly {
      readonly timestamp: string;
      readonly transcript: string;
      readonly actionId: string;
      readonly resultLine: string;
    }[];
  };
  readonly commands?: readonly {
    readonly name: string;
    readonly shortcut: string;
  }[];
  readonly storageValues?: Record<string, unknown>;
} = {}) {
  const elements = Object.fromEntries(
    elementIds.map((id) => [id, new FakeElement()]),
  ) as Record<(typeof elementIds)[number], FakeElement>;
  elements["setup-complete"].hidden = true;
  elements["guided-demo-chip"].hidden = true;
  elements["clipboard-card"].hidden = true;
  elements["reader-text-output"].hidden = true;
  elements["reading-text-output"].hidden = true;
  elements["reader-actions"].hidden = true;
  elements["reading-controls"].hidden = true;
  elements["latency-readout"].hidden = true;
  elements["settings-backup-confirm"].hidden = true;
  elements["command-alias-phrase-form"].hidden = true;
  elements["command-alias-target"].hidden = true;
  elements["command-alias-confirm"].hidden = true;
  elements["live-transcript-preview-setting"].hidden = true;
  elements["session-history-panel"].hidden = true;
  const emptyLog = new FakeElement("li");
  emptyLog.className = "empty-log";
  emptyLog.textContent = "No commands yet.";
  elements["action-log"].append(emptyLog);

  let onMessage: ((message: unknown) => void) | undefined;
  let onStorageChanged:
    | ((
        changes: Record<
          string,
          { readonly oldValue?: unknown; readonly newValue?: unknown }
        >,
        areaName: string,
      ) => void)
    | undefined;
  const documentListeners = new Map<string, Listener[]>();
  const requestPermission = vi.fn().mockResolvedValue(true);
  const clipboardWriteText = vi.fn().mockResolvedValue(undefined);
  const storageValues = options.storageValues ?? {};
  const storageSet = vi.fn(async (updates: Record<string, unknown>) => {
    Object.assign(storageValues, updates);
  });
  let blockedSites = options.blockedSites ?? {
    hostnames: [] as readonly string[],
    currentHostname: "example.com",
  };
  let sessionHistory = options.sessionHistory ?? {
    enabled: false,
    entries: [],
  };
  let aliasState = options.aliasState ?? {
    aliases: [],
    capture: { stage: "idle" as const },
  };
  const sendMessage = vi.fn().mockImplementation(
    async (message: {
      readonly type?: string;
      readonly enabled?: unknown;
      readonly hostname?: unknown;
      readonly phrase?: unknown;
    }) => {
      if (message.type === "get-diagnostic-report") {
        return {
          ok: true,
          value: "# Sotto diagnostic report\nGenerated: 2026-07-29T10:20:30.000Z",
        };
      }
      if (message.type === "get-speech-settings") {
        return {
          ok: true,
          value: options.speechSettings,
        };
      }
      if (message.type === "get-quiet-mode") {
        return {
          ok: true,
          value: options.quietMode ?? false,
        };
      }
      if (message.type === "get-session-history") {
        return { ok: true, value: sessionHistory };
      }
      if (message.type === "set-session-history-enabled") {
        sessionHistory = message.enabled === true
          ? { enabled: true, entries: sessionHistory.entries }
          : { enabled: false, entries: [] };
        return { ok: true, value: sessionHistory };
      }
      if (message.type === "clear-session-history") {
        sessionHistory = {
          enabled: sessionHistory.enabled,
          entries: [],
        };
        return { ok: true, value: sessionHistory };
      }
      if (message.type === "get-blocked-sites") {
        return { ok: true, value: blockedSites };
      }
      if (message.type === "get-command-alias-state") {
        return { ok: true, value: aliasState };
      }
      if (message.type === "start-command-alias-phrase-capture") {
        aliasState = {
          aliases: aliasState.aliases,
          capture: { stage: "phrase" },
        };
        return { ok: true, value: aliasState };
      }
      if (message.type === "start-command-alias-target-capture") {
        aliasState = {
          aliases: aliasState.aliases,
          capture: {
            stage: "target",
            phrase: message.phrase as string,
          },
        };
        return { ok: true, value: aliasState };
      }
      if (message.type === "cancel-command-alias-capture") {
        aliasState = {
          aliases: aliasState.aliases,
          capture: { stage: "idle" },
        };
        return { ok: true, value: aliasState };
      }
      if (message.type === "save-command-alias") {
        aliasState = {
          aliases: aliasState.aliases,
          capture: { stage: "idle" },
        };
        return { ok: true, value: aliasState };
      }
      if (message.type === "delete-command-alias") {
        aliasState = {
          aliases: aliasState.aliases.filter(
            (alias) => alias.phrase !== message.phrase,
          ),
          capture: aliasState.capture,
        };
        return { ok: true, value: aliasState };
      }
      if (message.type === "add-blocked-site") {
        blockedSites = {
          ...blockedSites,
          hostnames: [
            ...blockedSites.hostnames,
            message.hostname as string,
          ],
        };
        return { ok: true, value: blockedSites };
      }
      if (message.type === "block-current-site") {
        blockedSites = {
          ...blockedSites,
          hostnames: blockedSites.currentHostname === undefined
            ? blockedSites.hostnames
            : [
                ...blockedSites.hostnames,
                blockedSites.currentHostname,
              ],
        };
        return { ok: true, value: blockedSites };
      }
      if (message.type === "remove-blocked-site") {
        blockedSites = {
          ...blockedSites,
          hostnames: blockedSites.hostnames.filter(
            (hostname) => hostname !== message.hostname,
          ),
        };
        return { ok: true, value: blockedSites };
      }
      if (message.type === "preview-settings-import") {
        const preview = options.backupPreview ?? {
          valid: true,
          noteCount: 0,
        };
        return {
          ok: true,
          value: preview.valid
            ? {
                valid: true,
                preview: {
                  noteCount: preview.noteCount ?? 0,
                  aliasCount: preview.aliasCount ?? 0,
                  droppedAliasCount: preview.droppedAliasCount ?? 0,
                },
              }
            : { valid: false },
        };
      }
      if (message.type === "import-settings-backup") {
        const result = options.backupImport ?? {
          valid: true,
          addedNoteCount: 0,
        };
        return {
          ok: true,
          value: result.valid
            ? {
                valid: true,
                result: {
                  addedNoteCount: result.addedNoteCount ?? 0,
                  aliasCount: result.aliasCount ?? 0,
                  droppedAliasCount: result.droppedAliasCount ?? 0,
                },
              }
            : { valid: false },
        };
      }
      if (message.type === "set-quiet-mode") {
        return {
          ok: true,
          value: message.enabled,
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
      if (message.type === "delete-note") {
        return { ok: true, value: true };
      }
      if (message.type === "cancel-reminder") {
        return { ok: true, value: true };
      }
      return { ok: true };
    },
  );

  const body = new FakeElement("body");
  vi.stubGlobal("document", {
    body,
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
    matchMedia: vi.fn(() => ({
      matches: options.reducedMotion ?? false,
    })),
    setTimeout,
  });
  vi.stubGlobal("navigator", {
    clipboard: {
      writeText: clipboardWriteText,
    },
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
      getAll: vi.fn().mockResolvedValue(
        options.commands ?? [
          { name: "toggle-sotto", shortcut: "Alt+S" },
          { name: "read-this-page", shortcut: "Alt+R" },
        ],
      ),
    },
    storage: {
      local: {
        get: vi.fn(async (keys: string | readonly string[]) => {
          const selected = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(
            selected
              .filter((key) => key in storageValues)
              .map((key) => [key, storageValues[key]]),
          );
        }),
        set: storageSet,
      },
      onChanged: {
        addListener: vi.fn((listener) => {
          onStorageChanged = listener;
        }),
      },
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
    clipboardWriteText,
    emitDocument,
    onMessage,
    requestPermission,
    sendMessage,
    storageSet,
    storageValues,
    storageChanged: (
      changes: Record<
        string,
        { readonly oldValue?: unknown; readonly newValue?: unknown }
      >,
      areaName = "local",
    ) => onStorageChanged?.(changes, areaName),
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
  it("shows both hotkeys and flags an unassigned read hotkey", async () => {
    const { elements } = await installSidepanel({
      commands: [
        { name: "toggle-sotto", shortcut: "Alt+S" },
        { name: "read-this-page", shortcut: "" },
      ],
    });

    await vi.waitFor(() =>
      expect(elements["read-page-shortcut-label"].textContent).toBe(
        "UNASSIGNED",
      )
    );
    expect(elements["shortcut-label"].textContent).toBe("Alt+S");
    expect(elements["action-log"].textContent).toContain(
      "Assign Read this page in chrome://extensions/shortcuts.",
    );
    expect(elements["action-log"].textContent).not.toContain(
      "Assign Listen",
    );
  });

  it("copies one diagnostic report and adds one confirmation line", async () => {
    const {
      clipboardWriteText,
      elements,
      sendMessage,
    } = await installSidepanel();

    await elements["copy-diagnostic-report"].emit("click");

    expect(sendMessage).toHaveBeenCalledWith({
      target: "worker",
      type: "get-diagnostic-report",
    });
    expect(clipboardWriteText).toHaveBeenCalledOnce();
    expect(clipboardWriteText).toHaveBeenCalledWith(
      "# Sotto diagnostic report\nGenerated: 2026-07-29T10:20:30.000Z",
    );
    expect(elements["action-log"].children).toHaveLength(1);
    expect(elements["action-log"].textContent).toContain(
      "diagnostic report → Diagnostic report copied.",
    );
  });

  it("renders measured model storage and sends model actions", async () => {
    const { elements, onMessage, sendMessage } = await installSidepanel();
    onMessage({
      target: "sidepanel",
      type: "model-inventory",
      rows: [
        {
          id: "moonshine-tiny",
          label: "Moonshine tiny",
          state: "active",
          readOnly: false,
          bytes: 10,
          canDownload: false,
          canDelete: false,
        },
        {
          id: "moonshine-base",
          label: "Moonshine base",
          state: "absent",
          readOnly: false,
          bytes: 0,
          canDownload: true,
          canDelete: false,
        },
        {
          id: "kokoro",
          label: "Kokoro",
          state: "cached",
          readOnly: false,
          bytes: 30,
          canDownload: false,
          canDelete: true,
        },
        {
          id: "gemini-nano",
          label: "Gemini Nano",
          detail: "Chrome manages this model.",
          state: "cached",
          readOnly: true,
          canDownload: false,
          canDelete: false,
        },
        {
          id: "summarizer",
          label: "Summarizer",
          detail: "Chrome manages this model.",
          state: "absent",
          readOnly: true,
          canDownload: false,
          canDelete: false,
        },
      ],
      totalBytes: 40,
    });

    expect(elements["models-total"].textContent).toBe("Total: 40 B");
    expect(elements["models-list"].children).toHaveLength(5);
    expect(
      elements["models-list"].children[0]?.querySelector(".model-action"),
    ).toBeUndefined();
    expect(
      elements["models-list"].children[3]?.querySelector(".model-action"),
    ).toBeUndefined();

    const deleteButton =
      elements["models-list"].children[2]?.querySelector(".model-action");
    expect(deleteButton?.textContent).toBe("Delete");
    await deleteButton?.emit("click");
    await vi.waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith({
        target: "worker",
        type: "delete-model",
        modelId: "kokoro",
      })
    );
  });

  it("shows and persists bounded speech slider values", async () => {
    const { elements, sendMessage } = await installSidepanel({
      speechSettings: {
        rate: 1.3,
        volume: 0.55,
        verbosity: "brief",
      },
    });
    await vi.waitFor(() =>
      expect(elements["speech-rate-value"].textContent).toBe("1.3×")
    );
    expect(elements["speech-volume-value"].textContent).toBe("55%");
    expect(elements["response-verbosity"].value).toBe("brief");
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
        verbosity: "brief",
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
        verbosity: "brief",
      })
    );
    expect(elements["speech-volume-value"].textContent).toBe("0%");

    elements["response-verbosity"].value = "normal";
    await elements["response-verbosity"].emit("change");
    await vi.waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith({
        target: "worker",
        type: "set-speech-settings",
        rate: 2,
        volume: 0,
        verbosity: "normal",
      })
    );
  });

  it("updates speech controls when local storage changes", async () => {
    const { elements, sendMessage, storageChanged } = await installSidepanel({
      speechSettings: {
        rate: 1,
        volume: 1,
        verbosity: "normal",
      },
    });
    await vi.waitFor(() =>
      expect(elements["speech-rate-value"].textContent).toBe("1.0×")
    );
    sendMessage.mockClear();

    storageChanged({
      speechRate: { oldValue: 1, newValue: 1.25 },
      speechVolume: { oldValue: 1, newValue: 0.8 },
      responseVerbosity: { oldValue: "normal", newValue: "brief" },
    });

    expect(elements["speech-rate-value"].textContent).toBe("1.25×");
    expect(elements["speech-volume-value"].textContent).toBe("80%");
    expect(elements["response-verbosity"].value).toBe("brief");
    expect(sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "set-speech-settings" }),
    );
  });

  it("shows the active hostname and quick-adds and removes it", async () => {
    const { elements, sendMessage } = await installSidepanel({
      blockedSites: {
        hostnames: [],
        currentHostname: "news.example.com",
      },
    });
    await vi.waitFor(() =>
      expect(elements["block-current-site"].textContent).toBe(
        "Block this site: news.example.com",
      )
    );

    await elements["block-current-site"].emit("click");

    expect(sendMessage).toHaveBeenCalledWith({
      target: "worker",
      type: "block-current-site",
    });
    expect(elements["blocked-sites-list"].textContent).toContain(
      "news.example.com",
    );
    expect(elements["block-current-site"].disabled).toBe(true);

    const remove =
      elements["blocked-sites-list"].children[0]?.querySelector(".button");
    await remove?.emit("click");

    expect(sendMessage).toHaveBeenCalledWith({
      target: "worker",
      type: "remove-blocked-site",
      hostname: "news.example.com",
    });
    expect(elements["blocked-sites-list"].textContent).toBe(
      "No sites are blocked.",
    );
  });

  it("shows and saves quiet mode in the header", async () => {
    const { elements, sendMessage } = await installSidepanel({
      quietMode: true,
    });
    await vi.waitFor(() =>
      expect(elements["quiet-mode-label"].textContent).toBe("Quiet mode on")
    );
    expect(elements["quiet-mode"].checked).toBe(true);
    expect(elements["quiet-mode-control"].dataset.state).toBe("on");

    elements["quiet-mode"].checked = false;
    await elements["quiet-mode"].emit("change");

    expect(sendMessage).toHaveBeenCalledWith({
      target: "worker",
      type: "set-quiet-mode",
      enabled: false,
    });
    expect(elements["quiet-mode-label"].textContent).toBe("Quiet mode off");
    expect(elements["quiet-mode-control"].dataset.state).toBe("off");
  });

  it("keeps the actual wake phrase visible while the microphone is armed", async () => {
    const { elements, onMessage, sendMessage } = await installSidepanel();

    onMessage({
      target: "sidepanel",
      type: "wake-word-state",
      enabled: true,
      state: "armed",
    });

    expect(elements["wake-word-enabled"].checked).toBe(true);
    expect(elements["wake-word-indicator"].hidden).toBe(false);
    expect(elements["wake-word-indicator"].dataset.state).toBe("armed");
    expect(elements["wake-word-indicator-label"].textContent).toBe(
      'Wake phrase: "Hey Jarvis" (experimental) — Armed',
    );

    elements["wake-word-enabled"].checked = false;
    await elements["wake-word-enabled"].emit("change");
    expect(sendMessage).toHaveBeenCalledWith({
      target: "worker",
      type: "set-wake-word-enabled",
      enabled: false,
    });

    onMessage({
      target: "sidepanel",
      type: "wake-word-state",
      enabled: false,
      state: "disarmed",
    });
    expect(elements["wake-word-indicator"].hidden).toBe(true);
  });

  it("shows, appends, clears, and disables session history", async () => {
    const { elements, onMessage, sendMessage } = await installSidepanel({
      sessionHistory: {
        enabled: true,
        entries: [
          {
            timestamp: "2026-07-29T10:20:30.000Z",
            transcript: "open a new tab",
            actionId: "tabs",
            resultLine: "Opened a new tab.",
          },
          {
            timestamp: "2026-07-29T10:21:30.000Z",
            transcript: "close this tab",
            actionId: "tabs",
            resultLine: "Closed the tab.",
          },
        ],
      },
    });
    await vi.waitFor(() =>
      expect(elements["session-history-panel"].hidden).toBe(false)
    );
    expect(elements["session-history-enabled"].checked).toBe(true);
    expect(
      elements["session-history-list"].children[0]?.textContent,
    ).toContain("close this tab");

    onMessage({
      target: "sidepanel",
      type: "session-history-entry",
      entry: {
        timestamp: "2026-07-29T10:22:30.000Z",
        transcript: "switch to the GitHub tab",
        actionId: "tabs",
        resultLine: "Switched to GitHub.",
      },
      count: 3,
    });
    expect(
      elements["session-history-list"].children[0]?.textContent,
    ).toContain("switch to the GitHub tab");

    await elements["clear-session-history"].emit("click");
    expect(sendMessage).toHaveBeenCalledWith({
      target: "worker",
      type: "clear-session-history",
    });
    expect(elements["session-history-list"].textContent).toBe(
      "No session history.",
    );

    elements["session-history-enabled"].checked = false;
    await elements["session-history-enabled"].emit("change");
    expect(sendMessage).toHaveBeenCalledWith({
      target: "worker",
      type: "set-session-history-enabled",
      enabled: false,
    });
    expect(elements["session-history-panel"].hidden).toBe(true);
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
      type: "model-progress",
      model: "translator",
      progress: 0.25,
    });
    expect(elements["nano-progress-label"].textContent).toBe(
      "Chrome Translator",
    );
    expect(elements["nano-progress-value"].textContent).toBe("25%");

    onMessage({
      target: "sidepanel",
      type: "premium-stt-state",
      state: "not-downloaded",
      enabled: false,
      downloaded: false,
      resident: false,
      tier: "parakeet",
      backend: "webgpu",
      language: "auto",
    });
    expect(elements["premium-stt-copy"].textContent).toContain("409 MB");
    expect(elements["download-premium-stt"].textContent).toContain("409 MB");
    expect(elements["speech-language"].hidden).toBe(false);
    expect(elements["speech-language"].value).toBe("auto");
    expect(elements["speech-language-fixed"].hidden).toBe(true);

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
      language: "en",
    });
    expect(elements["premium-stt-copy"].textContent).toContain("63 MB");
    expect(elements["premium-stt-enabled"].checked).toBe(true);
    expect(elements["premium-stt-enabled"].disabled).toBe(false);
    expect(elements["speech-language"].hidden).toBe(true);
    expect(elements["speech-language-fixed"].hidden).toBe(false);
    expect(elements["speech-language-note"].textContent).toBe(
      "Moonshine supports English speech only.",
    );

    elements["premium-stt-enabled"].checked = false;
    await elements["premium-stt-enabled"].emit("change");
    expect(sendMessage).toHaveBeenCalledWith({
      target: "worker",
      type: "set-premium-stt-enabled",
      enabled: false,
    });

    onMessage({
      target: "sidepanel",
      type: "premium-stt-state",
      state: "active",
      enabled: true,
      downloaded: true,
      resident: true,
      tier: "parakeet",
      backend: "webgpu",
      language: "es",
    });
    expect(elements["speech-language"].value).toBe("es");
    elements["speech-language"].value = "fr";
    await elements["speech-language"].emit("change");
    expect(sendMessage).toHaveBeenCalledWith({
      target: "worker",
      type: "set-speech-language",
      language: "fr",
    });

    onMessage({
      target: "sidepanel",
      type: "stt-diagnostic",
      diagnostic: "vad-rejected",
      message: "Speech was too short or quiet.",
    });
    expect(elements.transcript.textContent).toBe(
      "Speech was too short or quiet.Speak closer to the microphone.",
    );
    expect(elements.transcript.dataset.diagnostic).toBe("vad-rejected");
    expect(
      elements.transcript.querySelector(".recovery-hint")?.textContent,
    ).toBe("Speak closer to the microphone.");
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

  it("shows provisional text without live announcements, then replaces it", async () => {
    const { elements, onMessage } = await installSidepanel();

    onMessage({
      target: "sidepanel",
      type: "partial-transcript",
      text: "open the",
    });
    expect(elements.transcript.textContent).toBe("open the");
    expect(elements.transcript.className).toContain("transcript-partial");
    expect(elements.transcript.getAttribute("aria-live")).toBe("off");

    onMessage({
      target: "sidepanel",
      type: "transcript",
      text: "open the calendar",
    });
    expect(elements.transcript.textContent).toBe("open the calendar");
    expect(elements.transcript.className).not.toContain("transcript-partial");
    expect(elements.transcript.getAttribute("aria-live")).toBe("polite");
  });

  it("shows and saves the WebGPU live transcript switch", async () => {
    const { elements, onMessage, sendMessage } = await installSidepanel();

    onMessage({
      target: "sidepanel",
      type: "live-transcript-preview-state",
      available: true,
      enabled: true,
    });
    expect(elements["live-transcript-preview-setting"].hidden).toBe(false);
    expect(elements["live-transcript-preview"].checked).toBe(true);

    elements["live-transcript-preview"].checked = false;
    await elements["live-transcript-preview"].emit("change");
    expect(sendMessage).toHaveBeenCalledWith({
      target: "worker",
      type: "set-live-transcript-preview-enabled",
      enabled: false,
    });

    onMessage({
      target: "sidepanel",
      type: "live-transcript-preview-state",
      available: false,
      enabled: false,
    });
    expect(elements["live-transcript-preview-setting"].hidden).toBe(true);
    expect(elements["live-transcript-preview"].disabled).toBe(true);
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

  it("advances the highlight on progress and skip, then clears on stop", async () => {
    const { elements, onMessage, sendMessage } = await installSidepanel();
    const text = "First sentence. Second sentence. Third sentence.";
    onMessage({
      target: "sidepanel",
      type: "page-text",
      title: "Article",
      text,
    });
    onMessage({
      target: "sidepanel",
      type: "reading-state",
      active: true,
      paused: false,
    });

    const sentences = elements["reading-text-output"].children.filter(
      (child): child is FakeElement => child instanceof FakeElement,
    );
    expect(sentences.map((sentence) => sentence.textContent)).toEqual([
      "First sentence.",
      "Second sentence.",
      "Third sentence.",
    ]);
    expect(sentences[0]?.dataset.state).toBe("active");
    expect(sentences[1]?.dataset.state).toBe("upcoming");
    expect(elements["page-text-output"].hidden).toBe(true);
    expect(elements["reading-text-output"].hidden).toBe(false);

    onMessage({
      target: "sidepanel",
      type: "reading-progress",
      current: "First sentence.".length,
      total: text.length,
      chunkIndex: 0,
      chunkCount: 3,
      chunkCharIndex: "First sentence.".length,
      eventType: "end",
    });
    expect(sentences[0]?.dataset.state).toBe("past");
    expect(sentences[1]?.dataset.state).toBe("active");
    expect(sentences[1]?.scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "nearest",
    });

    await elements["skip-reading"].emit("click");
    expect(sendMessage).toHaveBeenCalledWith({
      target: "worker",
      type: "playback-control",
      operation: "skip",
    });
    onMessage({
      target: "sidepanel",
      type: "reading-progress",
      current: "First sentence. Second sentence.".length,
      total: text.length,
      chunkIndex: 1,
      chunkCount: 3,
      chunkCharIndex: "Second sentence.".length,
      eventType: "end",
    });
    expect(sentences[1]?.dataset.state).toBe("past");
    expect(sentences[2]?.dataset.state).toBe("active");

    onMessage({
      target: "sidepanel",
      type: "reading-state",
      active: false,
      paused: false,
    });
    expect(elements["reading-text-output"].hidden).toBe(true);
    expect(elements["reading-text-output"].children).toHaveLength(0);
    expect(elements["page-text-output"].textContent).toBe("");
    expect(elements["page-text-card"].hidden).toBe(true);
  });

  it("moves the highlight without auto-scroll for reduced motion", async () => {
    const { elements, onMessage } = await installSidepanel({
      reducedMotion: true,
    });
    const text = "First. Second.";
    onMessage({ target: "sidepanel", type: "page-text", text });
    onMessage({
      target: "sidepanel",
      type: "reading-state",
      active: true,
      paused: false,
    });
    const sentences = elements["reading-text-output"].children.filter(
      (child): child is FakeElement => child instanceof FakeElement,
    );

    onMessage({
      target: "sidepanel",
      type: "reading-progress",
      current: "First.".length,
      total: text.length,
      chunkIndex: 0,
      chunkCount: 2,
      chunkCharIndex: "First.".length,
      eventType: "end",
    });

    expect(sentences[1]?.dataset.state).toBe("active");
    expect(sentences[1]?.scrollIntoView).not.toHaveBeenCalled();
  });

  it("keeps the guided setup expanded on a fresh install", async () => {
    const { elements } = await installSidepanel({
      capturePermissionGranted: false,
    });

    await vi.waitFor(() => {
      expect(elements["setup-capture"].dataset.state).toBe("needs-action");
    });
    expect(elements["setup-view"].hidden).toBe(false);
    expect(elements["setup-view"].dataset.state).toBe("expanded");
    expect(elements["setup-list"].hidden).toBe(false);
    expect(elements["setup-microphone"].dataset.state).toBe("pending");
    expect(elements["setup-nano"].dataset.state).toBe("pending");
  });

  it("reuses the existing setup actions without new grant logic", async () => {
    const { elements, onMessage, requestPermission, sendMessage } =
      await installSidepanel({
        capturePermissionGranted: false,
      });
    const create = vi.fn().mockResolvedValue({
      destroy: vi.fn(),
    });
    vi.stubGlobal("LanguageModel", { create });

    onMessage({
      target: "sidepanel",
      type: "engine-status",
      nano: "downloadable",
      listening: false,
      mic: "prompt",
    });

    await elements["setup-grant-mic"].emit("click");
    expect(sendMessage).toHaveBeenCalledWith({
      target: "worker",
      type: "open-microphone-page",
    });

    await elements["enable-capture"].emit("click");

    expect(requestPermission).toHaveBeenCalledWith({
      origins: ["<all_urls>"],
    });

    await elements["setup-prepare-nano"].emit("click");
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(sendMessage).toHaveBeenCalledWith({
      target: "worker",
      type: "nano-ready",
    });

    onMessage({
      target: "sidepanel",
      type: "premium-tts-state",
      state: "absent",
      enabled: false,
      voice: "af_heart",
    });
    onMessage({
      target: "sidepanel",
      type: "premium-stt-state",
      state: "not-downloaded",
      enabled: false,
      downloaded: false,
      resident: false,
      tier: "moonshine-base",
      backend: "wasm",
    });
    await elements["setup-download-premium"].emit("click");
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
    await elements["setup-download-premium"].emit("click");
    expect(sendMessage).toHaveBeenCalledWith({
      target: "worker",
      type: "prepare-premium-stt",
    });
  });

  it("collapses and dismisses setup when required steps pass", async () => {
    const { elements, onMessage } = await installSidepanel({
      capturePermissionGranted: true,
    });

    onMessage({
      target: "sidepanel",
      type: "engine-status",
      nano: "available",
      listening: false,
      mic: "granted",
    });

    expect(elements["setup-view"].dataset.state).toBe("complete");
    expect(elements["setup-list"].hidden).toBe(true);
    expect(elements["setup-complete"].hidden).toBe(false);

    await elements["dismiss-setup"].emit("click");
    expect(elements["setup-view"].hidden).toBe(true);
  });

  it("shows one guided suggestion only after required setup passes", async () => {
    const { elements, onMessage } = await installSidepanel({
      capturePermissionGranted: true,
    });

    expect(elements["guided-demo-chip"].hidden).toBe(true);
    onMessage({
      target: "sidepanel",
      type: "engine-status",
      nano: "available",
      listening: false,
      mic: "granted",
    });

    await vi.waitFor(() =>
      expect(elements["guided-demo-chip"].hidden).toBe(false)
    );
    expect(elements["guided-demo-text"].textContent).toBe(
      'Try saying: "take a screenshot."',
    );
    expect(elements["guided-demo-announcer"].textContent).toBe(
      'Try saying: "take a screenshot."',
    );

    onMessage({
      target: "sidepanel",
      type: "engine-status",
      nano: "available",
      listening: false,
      mic: "granted",
    });
    expect(elements["guided-demo-announcer"].textUpdateCount).toBe(1);
  });

  it("retires the guided suggestion after a successful command", async () => {
    const { elements, onMessage, storageValues } = await installSidepanel({
      capturePermissionGranted: true,
    });
    onMessage({
      target: "sidepanel",
      type: "engine-status",
      nano: "available",
      listening: false,
      mic: "granted",
    });
    await vi.waitFor(() =>
      expect(elements["guided-demo-chip"].hidden).toBe(false)
    );

    onMessage({
      target: "sidepanel",
      type: "action-log",
      heard: "list tabs",
      did: "2 tabs are open.",
    });

    expect(elements["guided-demo-chip"].hidden).toBe(true);
    await vi.waitFor(() =>
      expect(storageValues.guidedDemoRetired).toBe(true)
    );
  });

  it("retires the guided suggestion after explicit dismissal", async () => {
    const { elements, onMessage, storageValues } = await installSidepanel({
      capturePermissionGranted: true,
    });
    onMessage({
      target: "sidepanel",
      type: "engine-status",
      nano: "available",
      listening: false,
      mic: "granted",
    });
    await vi.waitFor(() =>
      expect(elements["guided-demo-chip"].hidden).toBe(false)
    );

    await elements["dismiss-guided-demo"].emit("click");

    expect(elements["guided-demo-chip"].hidden).toBe(true);
    await vi.waitFor(() =>
      expect(storageValues.guidedDemoRetired).toBe(true)
    );
  });

  it("keeps a retired guided suggestion hidden", async () => {
    const { elements, onMessage, storageSet } = await installSidepanel({
      capturePermissionGranted: true,
      storageValues: { guidedDemoRetired: true },
    });
    onMessage({
      target: "sidepanel",
      type: "engine-status",
      nano: "available",
      listening: false,
      mic: "granted",
    });

    await Promise.resolve();
    expect(elements["guided-demo-chip"].hidden).toBe(true);
    expect(storageSet).not.toHaveBeenCalled();
  });

  it("renders page-model and note text as inert textContent", async () => {
    const { elements, onMessage } = await installSidepanel();
    const untrusted =
      '<img src=x onerror="chrome.runtime.sendMessage(1)">. Safe sentence.';

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
          tag: untrusted.slice(0, 40),
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
    expect(elements["note-tag-filters"].textContent).toBe(
      untrusted.slice(0, 40),
    );

    onMessage({
      target: "sidepanel",
      type: "reading-state",
      active: true,
      paused: false,
    });
    const sentences = elements["reading-text-output"].children.filter(
      (child): child is FakeElement => child instanceof FakeElement,
    );
    expect(sentences.every((sentence) => sentence.tagName === "span")).toBe(
      true,
    );
    expect(sentences.map((sentence) => sentence.textContent).join(" ")).toBe(
      untrusted,
    );
    expect(
      sentences.every((sentence) => !sentence.listeners.has("click")),
    ).toBe(true);
  });

  it("renders reader paragraphs and keeps them after Read aloud", async () => {
    const { elements, onMessage, sendMessage } = await installSidepanel();
    const first = '<img src=x onerror="alert(1)"> First paragraph.';
    const second = "Second paragraph.";

    onMessage({
      target: "sidepanel",
      type: "reader-text",
      title: "Local article",
      text: `${first}\n\n${second}`,
    });

    const paragraphs = elements["reader-text-output"].children.filter(
      (child): child is FakeElement => child instanceof FakeElement,
    );
    expect(elements["page-text-title"].textContent).toBe("Local article");
    expect(paragraphs.map((paragraph) => paragraph.tagName)).toEqual([
      "p",
      "p",
    ]);
    expect(paragraphs.map((paragraph) => paragraph.textContent)).toEqual([
      first,
      second,
    ]);
    expect(elements["reader-actions"].hidden).toBe(false);

    await elements["read-reader"].emit("click");
    expect(sendMessage).toHaveBeenCalledWith({
      target: "worker",
      type: "read-reader",
    });

    onMessage({
      target: "sidepanel",
      type: "reading-state",
      active: true,
      paused: false,
    });
    expect(elements["reader-text-output"].hidden).toBe(true);
    expect(elements["reading-text-output"].hidden).toBe(false);

    onMessage({
      target: "sidepanel",
      type: "reading-state",
      active: false,
      paused: false,
    });
    expect(elements["reader-text-output"].hidden).toBe(false);
    expect(elements["reader-actions"].hidden).toBe(false);
    expect(elements["page-text-card"].hidden).toBe(false);

    onMessage({ target: "sidepanel", type: "reader-clear" });
    expect(elements["page-text-card"].hidden).toBe(true);
  });

  it("filters notes by text without a worker request", async () => {
    const { elements, onMessage, sendMessage } = await installSidepanel();
    onMessage({
      target: "sidepanel",
      type: "notes-updated",
      notes: [
        {
          id: "note-1",
          body: "Buy oat milk",
          createdAt: "2026-07-28T12:00:00.000Z",
          updatedAt: "2026-07-28T12:00:00.000Z",
        },
        {
          id: "note-2",
          body: "Check the build",
          createdAt: "2026-07-28T11:00:00.000Z",
          updatedAt: "2026-07-28T11:00:00.000Z",
        },
      ],
    });
    sendMessage.mockClear();

    elements["notes-search"].value = "MILK";
    await elements["notes-search"].emit("input");
    expect(elements["notes-list"].children).toHaveLength(1);
    expect(elements["notes-list"].textContent).toContain("Buy oat milk");
    expect(elements["notes-list"].textContent).not.toContain(
      "Check the build",
    );
    expect(sendMessage).not.toHaveBeenCalled();

    elements["notes-search"].value = "missing";
    await elements["notes-search"].emit("input");
    expect(elements["notes-list"].textContent).toBe(
      "No notes match your search.",
    );
  });

  it("combines tag chips with note text search", async () => {
    const { elements, onMessage, sendMessage } = await installSidepanel();
    onMessage({
      target: "sidepanel",
      type: "notes-updated",
      notes: [
        {
          id: "note-1",
          body: "Check the Apollo build",
          tag: "project apollo",
          createdAt: "2026-07-28T12:00:00.000Z",
          updatedAt: "2026-07-28T12:00:00.000Z",
        },
        {
          id: "note-2",
          body: "Call the Apollo team",
          tag: "project apollo",
          createdAt: "2026-07-28T11:00:00.000Z",
          updatedAt: "2026-07-28T11:00:00.000Z",
        },
        {
          id: "note-3",
          body: "Check the home alarm",
          tag: "home",
          createdAt: "2026-07-28T10:00:00.000Z",
          updatedAt: "2026-07-28T10:00:00.000Z",
        },
      ],
    });
    sendMessage.mockClear();

    const apollo = elements["note-tag-filters"].firstElementChild;
    expect(apollo?.tagName).toBe("button");
    expect(apollo?.attributes["aria-pressed"]).toBe("false");
    await apollo?.emit("click");
    expect(
      elements["note-tag-filters"].firstElementChild?.attributes[
        "aria-pressed"
      ],
    ).toBe("true");
    expect(elements["notes-list"].textContent).not.toContain(
      "Check the home alarm",
    );

    elements["notes-search"].value = "call";
    await elements["notes-search"].emit("input");
    expect(elements["notes-list"].textContent).toContain(
      "Call the Apollo team",
    );
    expect(elements["notes-list"].textContent).not.toContain(
      "Check the Apollo build",
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("shows storage counters only above eighty percent", async () => {
    const { elements, onMessage } = await installSidepanel();
    const notes = Array.from({ length: 401 }, (_, index) => ({
      id: `note-${index}`,
      body: `Note ${index}`,
      createdAt: "2026-07-28T12:00:00.000Z",
      updatedAt: "2026-07-28T12:00:00.000Z",
    }));
    const reminders = Array.from({ length: 81 }, (_, index) => ({
      id: `reminder-${index}`,
      text: `Reminder ${index}`,
      dueAt: "2026-07-28T12:30:00.000Z",
    }));

    onMessage({
      target: "sidepanel",
      type: "notes-updated",
      notes: notes.slice(0, 400),
    });
    onMessage({
      target: "sidepanel",
      type: "reminders-updated",
      reminders: reminders.slice(0, 80),
    });
    expect(elements["notes-count"].hidden).toBe(true);
    expect(elements["reminders-count"].hidden).toBe(true);

    onMessage({
      target: "sidepanel",
      type: "notes-updated",
      notes,
    });
    onMessage({
      target: "sidepanel",
      type: "reminders-updated",
      reminders,
    });
    expect(elements["notes-count"].hidden).toBe(false);
    expect(elements["notes-count"].textContent).toBe("401 of 500");
    expect(elements["reminders-count"].hidden).toBe(false);
    expect(elements["reminders-count"].textContent).toBe("81 of 100");
  });

  it("deletes one note after a deliberate panel click", async () => {
    const { elements, onMessage, sendMessage } = await installSidepanel();
    onMessage({
      target: "sidepanel",
      type: "notes-updated",
      notes: [
        {
          id: "note-1",
          body: "Buy oat milk",
          createdAt: "2026-07-28T12:00:00.000Z",
          updatedAt: "2026-07-28T12:00:00.000Z",
        },
      ],
    });
    const note = elements["notes-list"].firstElementChild;
    const details = note?.children[1] as FakeElement | undefined;
    const deleteButton = details?.children[1] as FakeElement | undefined;
    if (!deleteButton) throw new Error("Delete button was not rendered");

    await deleteButton.emit("click");

    expect(sendMessage).toHaveBeenCalledWith({
      target: "worker",
      type: "delete-note",
      noteId: "note-1",
    });
    expect(elements["notes-list"].textContent).toBe("No notes yet.");
  });

  it("sorts reminders and cancels one after a deliberate panel click", async () => {
    const { elements, onMessage, sendMessage } = await installSidepanel();
    onMessage({
      target: "sidepanel",
      type: "reminders-updated",
      reminders: [
        {
          id: "later",
          text: "Stretch",
          dueAt: "2026-07-28T12:30:00.000Z",
        },
        {
          id: "sooner",
          text: "Check the build",
          dueAt: "2026-07-28T12:12:00.000Z",
        },
      ],
    });

    expect(elements["reminders-list"].children).toHaveLength(2);
    expect(
      elements["reminders-list"].firstElementChild?.textContent,
    ).toContain("Check the build");
    const reminder = elements["reminders-list"].firstElementChild;
    const details = reminder?.children[1] as FakeElement | undefined;
    const cancelButton = details?.children[1] as FakeElement | undefined;
    if (!cancelButton) throw new Error("Cancel button was not rendered");

    await cancelButton.emit("click");

    expect(sendMessage).toHaveBeenCalledWith({
      target: "worker",
      type: "cancel-reminder",
      reminderId: "sooner",
    });
    expect(elements["reminders-list"].textContent).toContain("Stretch");
    expect(elements["reminders-list"].textContent).not.toContain(
      "Check the build",
    );
  });

  it("removes a fired reminder from the live list", async () => {
    const { elements, onMessage } = await installSidepanel();
    onMessage({
      target: "sidepanel",
      type: "reminders-updated",
      reminders: [
        {
          id: "build",
          text: "Check the build",
          dueAt: "2026-07-28T12:12:00.000Z",
        },
      ],
    });

    onMessage({
      target: "sidepanel",
      type: "reminder-fired",
      reminder: {
        id: "build",
        text: "Check the build",
        dueAt: "2026-07-28T12:12:00.000Z",
        notificationPermission: "granted",
      },
    });

    expect(elements["reminders-list"].textContent).toBe(
      "No pending reminders.",
    );
    expect(elements["reminder-banner"].textContent).toBe(
      "Reminder: Check the build",
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
      notes: [
        {
          id: "bad",
          body: "Bad",
          tag: "x".repeat(41),
          createdAt: "2026-07-28T12:00:00.000Z",
          updatedAt: "2026-07-28T12:00:00.000Z",
        },
      ],
    });
    onMessage({
      target: "sidepanel",
      type: "reminders-updated",
      reminders: [{ id: "bad", text: "Bad", dueAt: "not-a-date" }],
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
    expect(warn).toHaveBeenCalledTimes(4);
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
      "Chrome cannot copy while Sotto and the page are inactive. Select Copy.";
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

  it("updates the compact and expanded latency readout", async () => {
    const { elements, onMessage } = await installSidepanel();

    onMessage({
      target: "sidepanel",
      type: "latency-statistics",
      statistics: {
        sampleCount: 2,
        stt: { sampleCount: 1, p50Ms: 420, p95Ms: 420 },
        parse: { sampleCount: 2, p50Ms: 310, p95Ms: 500 },
        act: { sampleCount: 2, p50Ms: 45, p95Ms: 90 },
        voice: { sampleCount: 1, p50Ms: 1_100, p95Ms: 1_100 },
        total: { sampleCount: 2, p50Ms: 855, p95Ms: 1_690 },
      },
    });

    expect(elements["latency-readout"].hidden).toBe(false);
    expect(elements["latency-summary"].textContent).toBe(
      "p50 855ms · p95 1.7s (n=2)",
    );
    expect(elements["latency-details"].textContent).toContain(
      "Speech input420ms420ms1",
    );
    expect(elements["latency-details"].textContent).toContain(
      "Voice1.1s1.1s1",
    );
  });

  it("renders a recovery hint with the error line", async () => {
    const { elements, onMessage } = await installSidepanel();

    onMessage({
      target: "sidepanel",
      type: "pipeline-error",
      message: "Speech feedback failed.",
      errorClass: "tts-failure",
    });

    expect(elements["pipeline-error"].textContent).toBe(
      "Speech feedback failed.Check the sound output.",
    );
    expect(
      elements["pipeline-error"].querySelector(".recovery-hint")?.textContent,
    ).toBe("Check the sound output.");
    expect(
      elements["action-log"].firstElementChild
        ?.querySelector(".recovery-hint")?.textContent,
    ).toBe("Check the sound output.");
    expect(elements["action-log-announcer"].textContent).toBe("");
  });

  it("renders no recovery hint for a restricted page", async () => {
    const { elements, onMessage } = await installSidepanel();

    onMessage({
      target: "sidepanel",
      type: "pipeline-error",
      message: "Sotto cannot use this page.",
      errorClass: "restricted-page",
    });

    expect(
      elements["pipeline-error"].querySelector(".recovery-hint"),
    ).toBeUndefined();
    expect(
      elements["action-log"].firstElementChild
        ?.querySelector(".recovery-hint"),
    ).toBeUndefined();
  });

  it("shows one backup confirmation before it applies the import", async () => {
    const { elements, sendMessage } = await installSidepanel({
      backupPreview: {
        valid: true,
        noteCount: 12,
        aliasCount: 3,
      },
      backupImport: {
        valid: true,
        addedNoteCount: 10,
        aliasCount: 3,
        droppedAliasCount: 2,
      },
    });
    const backup = '{"schemaVersion":1}';
    elements["settings-backup-file"].files = [{
      size: backup.length,
      text: async () => backup,
    }];

    await elements["settings-backup-file"].emit("change");

    expect(elements["settings-backup-confirm"].hidden).toBe(false);
    expect(elements["settings-backup-confirm-copy"].textContent).toBe(
      "Import 12 notes and settings? This replaces your settings.",
    );
    expect(sendMessage).toHaveBeenCalledWith({
      target: "worker",
      type: "preview-settings-import",
      backup,
    });
    expect(sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "import-settings-backup" }),
    );

    await elements["confirm-settings-import"].emit("click");

    expect(sendMessage).toHaveBeenCalledWith({
      target: "worker",
      type: "import-settings-backup",
      backup,
    });
    expect(elements["settings-backup-confirm"].hidden).toBe(true);
    expect(elements["settings-backup-status"].textContent).toBe(
      "Import complete. Settings replaced. Added 10 notes. " +
        "Imported 3 aliases. Dropped 2 invalid aliases.",
    );
  });

  it("captures a typed alias phrase and waits for its command", async () => {
    const { elements, sendMessage } = await installSidepanel();

    await elements["add-command-alias"].emit("click");
    expect(elements["command-alias-phrase-form"].hidden).toBe(false);

    elements["command-alias-phrase"].value = "focus work";
    await elements["command-alias-phrase-form"].emit("submit");

    expect(sendMessage).toHaveBeenCalledWith({
      target: "worker",
      type: "start-command-alias-target-capture",
      phrase: "focus work",
    });
    expect(elements["command-alias-target"].hidden).toBe(false);
    expect(elements["command-alias-target-phrase"].textContent).toBe(
      "focus work",
    );
  });

  it("starts listening after it starts phrase capture", async () => {
    const { elements, sendMessage } = await installSidepanel();

    await elements["add-command-alias"].emit("click");
    await elements["speak-command-alias-phrase"].emit("click");

    expect(sendMessage).toHaveBeenNthCalledWith(1, {
      target: "worker",
      type: "start-command-alias-phrase-capture",
    });
    expect(sendMessage).toHaveBeenNthCalledWith(2, {
      target: "worker",
      type: "toggle-listening",
    });
    expect(
      elements["command-alias-phrase-instruction"].textContent,
    ).toBe("Speak the alias phrase now.");
  });

  it("shows the exact captured command and sends save", async () => {
    const { elements, onMessage, sendMessage } = await installSidepanel();
    onMessage({
      target: "sidepanel",
      type: "command-alias-state",
      state: {
        aliases: [],
        capture: {
          stage: "confirm",
          phrase: "focus work",
          command: {
            action: "tabs",
            operation: "switch",
            query: "project board",
          },
        },
      },
    });

    expect(elements["command-alias-confirm"].hidden).toBe(false);
    expect(elements["command-alias-confirm-phrase"].textContent).toBe(
      "focus work",
    );
    expect(elements["command-alias-confirm-command"].textContent).toBe(
      '{\n  "action": "tabs",\n  "operation": "switch",\n' +
        '  "query": "project board"\n}',
    );

    await elements["save-command-alias"].emit("click");
    expect(sendMessage).toHaveBeenCalledWith({
      target: "worker",
      type: "save-command-alias",
    });
  });

  it("lists aliases, reports messages, and sends delete", async () => {
    const { elements, onMessage, sendMessage } = await installSidepanel();
    onMessage({
      target: "sidepanel",
      type: "command-alias-state",
      state: {
        aliases: [{
          phrase: "focus work",
          command: { action: "tabs", operation: "switch", query: "work" },
        }],
        capture: { stage: "idle" },
        message: "Alias saved.",
      },
    });

    expect(elements["command-alias-count"].textContent).toBe("1 of 50");
    expect(elements["command-alias-list"].textContent).toContain(
      "focus work",
    );
    expect(elements["command-alias-status"].textContent).toBe(
      "Alias saved.",
    );

    const remove =
      elements["command-alias-list"].firstElementChild?.querySelector(
        ".button",
      );
    await remove?.emit("click");
    expect(sendMessage).toHaveBeenCalledWith({
      target: "worker",
      type: "delete-command-alias",
      phrase: "focus work",
    });
  });

  it("stops new alias setup at 50 aliases", async () => {
    const aliases = Array.from({ length: 50 }, (_, index) => ({
      phrase: `alias ${index}`,
      command: { action: "tabs", operation: "switch", index },
    }));
    const { elements } = await installSidepanel({
      aliasState: {
        aliases,
        capture: { stage: "idle" },
      },
    });

    await vi.waitFor(() => {
      expect(elements["command-alias-count"].textContent).toBe("50 of 50");
    });
    expect(elements["add-command-alias"].disabled).toBe(true);
  });

  it("shows one clear line for an invalid backup", async () => {
    const { elements, sendMessage } = await installSidepanel({
      backupPreview: { valid: false },
    });
    const backup = "not json";
    elements["settings-backup-file"].files = [{
      size: backup.length,
      text: async () => backup,
    }];

    await elements["settings-backup-file"].emit("change");

    expect(elements["settings-backup-status"].textContent).toBe(
      "This backup file is not valid.",
    );
    expect(elements["settings-backup-confirm"].hidden).toBe(true);
    expect(sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "import-settings-backup" }),
    );
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

  it("reuses the capture permission retry for a screen question", async () => {
    const {
      elements,
      onMessage,
      requestPermission,
      sendMessage,
    } = await installSidepanel();
    const pendingCommand = {
      action: "ask-screen",
      question: "What is this chart?",
    };

    onMessage({
      target: "sidepanel",
      type: "screenshot-permission-needed",
      workflow: {
        kind: "screenshot-permission",
        originPattern: "<all_urls>",
        host: "example.test",
        pendingCommand,
      },
    });
    await elements["copy-screenshot"].emit("click");

    expect(requestPermission).toHaveBeenCalledWith({
      origins: ["<all_urls>"],
    });
    expect(sendMessage).toHaveBeenCalledWith({
      target: "worker",
      type: "retry-screenshot",
      command: pendingCommand,
    });
    expect(clipboard.perform).not.toHaveBeenCalled();
    expect(elements["clipboard-card"].hidden).toBe(true);
  });
});
