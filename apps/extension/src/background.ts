import actions from "@sotto/actions";
import { createNotesMarkdownExport } from "@sotto/actions/notes/markdown";
import {
  isReminderRecord,
  notesReminderStore,
  restrictNotesStorageAccess,
  type NoteRecord,
  type ReminderRecord,
} from "@sotto/actions/notes/storage";
import {
  ActionRegistry,
  CommandRouter,
  CommandValidationError,
  DestinationRegistry,
  type ActionCommand,
  type ActionResult,
  type ClipboardWorkflow,
  type DestinationFollowUp,
  type EditableActionServices,
  type ExtractedPageText,
  type PageActionServices,
  type PageModelTask,
} from "@sotto/core";
import destinations, {
  executeDestinationFollowUp,
  type ClipboardWorkflowCompletion,
} from "@sotto/destinations";
import { SystemTtsEngine } from "@sotto/tts";
import {
  PremiumTtsRouter,
  type PremiumTtsState,
} from "./premium-tts.js";

interface WorkerMessage {
  readonly target: "worker";
  readonly type: string;
  readonly text?: unknown;
  readonly command?: unknown;
  readonly transcript?: unknown;
  readonly completion?: unknown;
  readonly reminderId?: unknown;
  readonly utteranceId?: unknown;
  readonly state?: unknown;
  readonly enabled?: unknown;
  readonly backend?: unknown;
  readonly error?: unknown;
}

const actionRegistry = new ActionRegistry(actions);
const destinationRegistry = new DestinationRegistry(destinations);
const commandRouter = new CommandRouter(actionRegistry);
const systemTts = new SystemTtsEngine();
const tts = new PremiumTtsRouter({
  system: systemTts,
  request: (request) => sendOffscreen({ ...request }),
});

let creatingOffscreen: Promise<void> | undefined;
let commandGeneration = 0;

function beginCommandGeneration(): number {
  commandGeneration += 1;
  tts.stop();
  return commandGeneration;
}

function commandIsCurrent(generation: number): boolean {
  return generation === commandGeneration;
}

async function ensureOffscreen(path = "offscreen.html"): Promise<void> {
  const url = chrome.runtime.getURL(path);
  const existing = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [url],
  });
  if (existing.length > 0) return;

  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: path,
      reasons: ["USER_MEDIA", "AUDIO_PLAYBACK"],
      justification:
        "Capture microphone audio and play fully local premium speech",
    });
  }

  try {
    await creatingOffscreen;
  } finally {
    creatingOffscreen = undefined;
  }
}

async function sendOffscreen(message: Record<string, unknown>): Promise<unknown> {
  const request = {
    target: "offscreen",
    ...message,
  };
  await ensureOffscreen();

  let rawResponse: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      rawResponse = await chrome.runtime.sendMessage(request);
      break;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (
        !detail.includes("Receiving end does not exist") ||
        attempt === 2
      ) {
        throw error;
      }
      // createDocument() can resolve just before a module listener finishes
      // registering. Give that existing context a bounded readiness window.
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 25 * (attempt + 1));
      });
      await ensureOffscreen();
    }
  }

  const response = rawResponse as
    | {
        readonly ok: boolean;
        readonly value?: unknown;
        readonly error?: { readonly message?: string };
      }
    | undefined;
  if (response?.ok === false) {
    throw new Error(response.error?.message ?? "Offscreen request failed");
  }
  return response?.value;
}

async function sendPanel(message: Record<string, unknown>): Promise<boolean> {
  try {
    await chrome.runtime.sendMessage({ target: "sidepanel", ...message });
    return true;
  } catch {
    // The panel is intentionally optional; hotkey voice commands still work.
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function reportBackgroundFailure(
  context: string,
  error: unknown,
  spoken?: string,
): Promise<void> {
  const detail = errorMessage(error);
  console.warn(context, error);
  await sendPanel({ type: "pipeline-error", message: `${context}: ${detail}` });
  if (spoken) {
    try {
      await tts.speak(spoken, { lang: "en-US" });
    } catch (ttsError) {
      console.warn("Sotto could not speak an error response", ttsError);
    }
  }
}

function runAndReport(
  promise: Promise<unknown>,
  context: string,
  spoken?: string,
): void {
  void promise.catch((error: unknown) =>
    reportBackgroundFailure(context, error, spoken),
  );
}

function panelNote(note: NoteRecord): Record<string, unknown> {
  return {
    id: note.id,
    body: note.body,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    ...(note.source === undefined
      ? {}
      : { source: { title: note.source.title, url: note.source.url } }),
  };
}

async function publishNotes(): Promise<readonly NoteRecord[]> {
  const notes = await notesReminderStore.listNotes();
  await sendPanel({
    type: "notes-updated",
    notes: notes.map(panelNote),
  });
  return notes;
}

async function deliverReminder(reminder: ReminderRecord): Promise<void> {
  const notificationId = reminderNotificationId(reminder);
  const permission = await chrome.notifications.getPermissionLevel();
  let notificationDelivered = false;
  if (permission === "granted") {
    await chrome.notifications.create(notificationId, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
      title: "Sotto reminder",
      message: reminder.text,
      eventTime: Date.parse(reminder.dueAt),
    });
    notificationDelivered = true;
  }
  const panelDelivered = await sendPanel({
    type: "reminder-fired",
    reminder: {
      id: reminder.id,
      text: reminder.text,
      dueAt: reminder.dueAt,
      notificationPermission: permission,
    },
  });
  let speechDelivered = false;
  try {
    await tts.speak(`Reminder: ${reminder.text}`, { lang: "en-US" });
    speechDelivered = true;
  } catch (error) {
    console.warn("Sotto could not speak the reminder", error);
  }
  if (!notificationDelivered && !panelDelivered && !speechDelivered) {
    throw new Error(
      "Reminder delivery failed because notifications are denied and no fallback is available",
    );
  }
}

async function reconcileReminders(): Promise<void> {
  await notesReminderStore.reconcileReminders({
    onDue: deliverReminder,
  });
}

async function loadReminder(
  reminderKey: string,
): Promise<ReminderRecord | undefined> {
  const values = await chrome.storage.local.get([
    "schemaVersion",
    reminderKey,
  ]);
  const value = values[reminderKey];
  return isReminderRecord(value) ? value : undefined;
}

const REMINDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const REMINDER_NOTIFICATION_PATTERN =
  /^reminder:([A-Za-z0-9][A-Za-z0-9_-]{0,127})(?::window:(\d+))?$/;

function reminderNotificationId(reminder: ReminderRecord): string {
  return reminder.sourceWindowId === undefined
    ? `reminder:${reminder.id}`
    : `reminder:${reminder.id}:window:${reminder.sourceWindowId}`;
}

function parseReminderNotificationId(
  value: unknown,
):
  | {
      readonly reminderId: string;
      readonly reminderKey: string;
      readonly sourceWindowId?: number;
    }
  | undefined {
  if (typeof value !== "string") return undefined;
  const match = REMINDER_NOTIFICATION_PATTERN.exec(value);
  const reminderId = match?.[1];
  if (!reminderId) return undefined;
  const rawWindowId = match[2];
  if (rawWindowId === undefined) {
    return {
      reminderId,
      reminderKey: `reminder:${reminderId}`,
    };
  }
  const sourceWindowId = Number(rawWindowId);
  if (!Number.isSafeInteger(sourceWindowId) || sourceWindowId < 0) {
    return undefined;
  }
  return {
    reminderId,
    reminderKey: `reminder:${reminderId}`,
    sourceWindowId,
  };
}

function safeTranscript(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 2_000) : "";
}

function safeTtsLanguage(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 35 ||
    !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(value.trim())
  ) {
    return "en-US";
  }
  return value.trim();
}

const PAGE_SOURCES = new Set<ExtractedPageText["source"]>([
  "selection",
  "readability",
  "article",
  "main",
  "body",
]);

function parseExtractedPage(value: unknown): ExtractedPageText {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("The page extractor returned invalid data");
  }
  const candidate = value as {
    text?: unknown;
    title?: unknown;
    url?: unknown;
    language?: unknown;
    source?: unknown;
    truncated?: unknown;
  };
  if (
    typeof candidate.text !== "string" ||
    !candidate.text.trim() ||
    candidate.text.length > 120_000 ||
    typeof candidate.title !== "string" ||
    candidate.title.length > 500 ||
    typeof candidate.url !== "string" ||
    candidate.url.length > 4_000 ||
    typeof candidate.source !== "string" ||
    !PAGE_SOURCES.has(candidate.source as ExtractedPageText["source"]) ||
    typeof candidate.truncated !== "boolean" ||
    (candidate.language !== undefined &&
      (typeof candidate.language !== "string" ||
        candidate.language.length > 35))
  ) {
    throw new TypeError("The page extractor exceeded its data contract");
  }
  return {
    text: candidate.text,
    title: candidate.title,
    url: candidate.url,
    source: candidate.source as ExtractedPageText["source"],
    truncated: candidate.truncated,
    ...(typeof candidate.language === "string"
      ? { language: candidate.language }
      : {}),
  };
}

async function extractActivePage(
  options: Parameters<PageActionServices["extract"]>[0],
): Promise<ExtractedPageText> {
  const [activeTab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  if (activeTab?.id === undefined) {
    throw new Error("No active tab is available to read");
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: activeTab.id, frameIds: [0] },
      files: ["extractPage.js"],
      world: "ISOLATED",
    });
    const raw = (await chrome.tabs.sendMessage(
      activeTab.id,
      {
        target: "sotto-page-extractor",
        options,
      },
      { frameId: 0 },
    )) as
      | {
          readonly ok?: unknown;
          readonly value?: unknown;
          readonly error?: unknown;
        }
      | undefined;
    if (raw?.ok !== true) {
      throw new Error(
        typeof raw?.error === "string"
          ? raw.error
          : "Sotto could not find readable text on this page.",
      );
    }
    return parseExtractedPage(raw.value);
  } catch (error) {
    const detail = errorMessage(error);
    if (
      detail.startsWith("Select some text") ||
      detail.startsWith("Sotto could not find readable text")
    ) {
      throw error;
    }
    throw new Error("Sotto cannot read this page.");
  }
}

async function runPageModelTask(task: PageModelTask): Promise<string> {
  const value = await sendOffscreen({
    type: "page-task",
    task: {
      role: task.role,
      pageText: task.page.text,
      ...(task.page.language === undefined
        ? {}
        : { language: task.page.language }),
      ...(task.role === "ask-page" ? { question: task.question } : {}),
    },
  });
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 24_000
  ) {
    throw new Error("The on-device page model returned invalid text");
  }
  return value;
}

const pageActionServices: PageActionServices = {
  extract: extractActivePage,
  runModelTask: runPageModelTask,
};

interface EditorBridgeLocation {
  readonly tabId: number;
  readonly frameId: number;
  readonly documentId?: string;
  readonly bridgeSnapshotId: string;
}

const editorSnapshots = new Map<string, EditorBridgeLocation>();
const rewriteFallbacks = new Map<string, string>();
const pendingClipboardWorkflows = new Map<
  string,
  {
    readonly followUp?: DestinationFollowUp;
    readonly spoken?: string;
  }
>();

function bridgeMessageOptions(
  location: Pick<EditorBridgeLocation, "frameId" | "documentId">,
): { readonly frameId: number; readonly documentId?: string } {
  return {
    frameId: location.frameId,
    ...(location.documentId === undefined
      ? {}
      : { documentId: location.documentId }),
  };
}

function parseEditorCapture(value: unknown): {
  readonly snapshotId: string;
  readonly selectedText: string;
  readonly source: "caret" | "selection" | "last-dictated";
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("The editor bridge returned invalid capture data");
  }
  const capture = value as {
    snapshotId?: unknown;
    selectedText?: unknown;
    source?: unknown;
  };
  if (
    typeof capture.snapshotId !== "string" ||
    typeof capture.selectedText !== "string" ||
    capture.selectedText.length > 24_000 ||
    (capture.source !== "caret" &&
      capture.source !== "selection" &&
      capture.source !== "last-dictated")
  ) {
    throw new TypeError("The editor capture exceeded its data contract");
  }
  return {
    snapshotId: capture.snapshotId,
    selectedText: capture.selectedText,
    source: capture.source,
  };
}

async function captureEditable(
  options: Parameters<EditableActionServices["capture"]>[0],
): ReturnType<EditableActionServices["capture"]> {
  const [activeTab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  if (activeTab?.id === undefined) {
    throw new Error("No active tab has a focused editor");
  }

  let frames: chrome.scripting.InjectionResult<unknown>[];
  try {
    frames = await chrome.scripting.executeScript({
      target: { tabId: activeTab.id, allFrames: true },
      files: ["typeBridge.js"],
      world: "ISOLATED",
    });
  } catch {
    throw new Error("The focused editor is in an inaccessible frame.");
  }

  const captures: Array<{
    readonly capture: ReturnType<typeof parseEditorCapture>;
    readonly location: Omit<EditorBridgeLocation, "bridgeSnapshotId">;
  }> = [];
  const errors: string[] = [];
  for (const frame of frames) {
    try {
      const raw = (await chrome.tabs.sendMessage(
        activeTab.id,
        {
          target: "sotto-type-bridge",
          type: "capture",
          options,
        },
        bridgeMessageOptions({
          frameId: frame.frameId,
          ...(frame.documentId === undefined
            ? {}
            : { documentId: frame.documentId }),
        }),
      )) as
        | {
            readonly ok?: unknown;
            readonly value?: unknown;
            readonly error?: {
              readonly code?: unknown;
              readonly message?: unknown;
            };
          }
        | undefined;
      if (raw?.ok !== true) {
        if (typeof raw?.error?.message === "string") {
          errors.push(raw.error.message);
        }
        continue;
      }
      captures.push({
        capture: parseEditorCapture(raw.value),
        location: {
          tabId: activeTab.id,
          frameId: frame.frameId,
          ...(frame.documentId === undefined
            ? {}
            : { documentId: frame.documentId }),
        },
      });
    } catch (error) {
      errors.push(errorMessage(error));
    }
  }

  if (captures.length !== 1) {
    const selectionError = errors.find((message) =>
      message.startsWith("Select text"),
    );
    throw new Error(
      selectionError ??
        (captures.length > 1
          ? "Sotto found more than one focused editor and refused to guess."
          : "The focused editor is inaccessible or too complex to edit safely."),
    );
  }

  const selected = captures[0]!;
  const snapshotId = crypto.randomUUID();
  editorSnapshots.clear();
  editorSnapshots.set(snapshotId, {
    ...selected.location,
    bridgeSnapshotId: selected.capture.snapshotId,
  });
  return {
    snapshotId,
    selectedText: selected.capture.selectedText,
    source: selected.capture.source,
  };
}

async function commitEditable(
  options: Parameters<EditableActionServices["commit"]>[0],
): ReturnType<EditableActionServices["commit"]> {
  const location = editorSnapshots.get(options.snapshotId);
  editorSnapshots.delete(options.snapshotId);
  const rewriteFallback = rewriteFallbacks.get(options.snapshotId);
  rewriteFallbacks.delete(options.snapshotId);

  try {
    if (!location) throw new Error("The editor snapshot is no longer valid.");
    const raw = (await chrome.tabs.sendMessage(
      location.tabId,
      {
        target: "sotto-type-bridge",
        type: "commit",
        snapshotId: location.bridgeSnapshotId,
        text: options.text,
        inputType: options.inputType,
        rememberAsDictation: options.rememberAsDictation,
      },
      bridgeMessageOptions(location),
    )) as
      | {
          readonly ok?: unknown;
          readonly value?: unknown;
          readonly error?: { readonly message?: unknown };
        }
      | undefined;
    if (raw?.ok !== true) {
      throw new Error(
        typeof raw?.error?.message === "string"
          ? raw.error.message
          : "The editor rejected the text change.",
      );
    }
    const kind = (raw.value as { kind?: unknown } | undefined)?.kind;
    if (
      kind !== "input" &&
      kind !== "textarea" &&
      kind !== "contenteditable"
    ) {
      throw new TypeError("The editor bridge returned an invalid commit");
    }
    return { kind };
  } catch (error) {
    if (rewriteFallback === options.text) {
      await sendPanel({
        type: "rewrite-fallback",
        text: options.text,
      });
    }
    throw error;
  }
}

async function rewriteEditable(
  options: Parameters<EditableActionServices["rewrite"]>[0],
): ReturnType<EditableActionServices["rewrite"]> {
  if (!editorSnapshots.has(options.snapshotId)) {
    throw new Error("The editor snapshot is no longer valid.");
  }
  if (!options.source.trim() || options.source.length > 24_000) {
    throw new TypeError("Rewrite source is empty or exceeds the edit bound");
  }
  const value = await sendOffscreen({
    type: "rewrite-task",
    sourceText: options.source,
    transformation: options.transformation,
  });
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 24_000
  ) {
    throw new Error("The on-device rewrite model returned invalid text");
  }
  rewriteFallbacks.set(options.snapshotId, value);
  return value;
}

const editableActionServices: EditableActionServices = {
  capture: captureEditable,
  commit: commitEditable,
  rewrite: rewriteEditable,
};

function isAllowedFollowUp(value: unknown): value is DestinationFollowUp {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as {
    kind?: unknown;
    matchPatterns?: unknown;
    createUrl?: unknown;
  };
  return (
    candidate.kind === "focus-or-open-tab" &&
    candidate.createUrl === "https://claude.ai/new" &&
    Array.isArray(candidate.matchPatterns) &&
    candidate.matchPatterns.length === 1 &&
    candidate.matchPatterns[0] === "https://claude.ai/*"
  );
}

function parseClipboardWorkflowCompletion(
  value: unknown,
): ClipboardWorkflowCompletion {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Rejected an invalid clipboard completion");
  }
  const candidate = value as {
    workflowId?: unknown;
    followUp?: unknown;
    spoken?: unknown;
  };
  if (typeof candidate.workflowId !== "string") {
    throw new TypeError("Clipboard completion requires a workflow id");
  }
  if (
    candidate.followUp !== undefined &&
    !isAllowedFollowUp(candidate.followUp)
  ) {
    throw new TypeError("Rejected an invalid destination follow-up");
  }
  if (
    candidate.spoken !== undefined &&
    typeof candidate.spoken !== "string"
  ) {
    throw new TypeError("Rejected an invalid clipboard confirmation");
  }
  return {
    workflowId: candidate.workflowId,
    ...(candidate.followUp === undefined
      ? {}
      : { followUp: candidate.followUp }),
    ...(candidate.spoken === undefined
      ? {}
      : { spoken: candidate.spoken.slice(0, 240) }),
  };
}

async function completeClipboardWorkflow(
  completion: ClipboardWorkflowCompletion,
): Promise<void> {
  if (!pendingClipboardWorkflows.has(completion.workflowId)) {
    throw new TypeError("Clipboard workflow is unknown or already completed");
  }
  const issued = pendingClipboardWorkflows.get(completion.workflowId)!;
  pendingClipboardWorkflows.delete(completion.workflowId);
  if (issued.followUp) {
    await executeDestinationFollowUp(issued.followUp);
  }
  const spoken = issued.spoken ?? "Screenshot copied.";
  await sendOffscreen({
    type: "workflow-complete",
    spoken,
  });
  await sendPanel({
    type: "action-log",
    heard: "copy screenshot",
    did: issued.followUp ? "copied and opened Claude" : "copied",
  });
}

function registerClipboardWorkflow(workflow: ClipboardWorkflow): void {
  pendingClipboardWorkflows.clear();
  pendingClipboardWorkflows.set(
    workflow.id,
    workflow.afterWrite ?? {},
  );
}

async function writeClipboardInActiveTab(
  workflow: ClipboardWorkflow,
): Promise<boolean> {
  try {
    const [activeTab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (activeTab?.id === undefined) {
      throw new Error("No active tab is available for clipboard access");
    }

    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: activeTab.id },
      func: async (
        dataUrl: string,
        mimeType: "image/png",
      ): Promise<
        { readonly ok: true } | { readonly ok: false; readonly error: string }
      > => {
        try {
          const response = await fetch(dataUrl);
          if (!response.ok) {
            throw new Error(
              "Could not prepare the screenshot for the clipboard",
            );
          }
          const blob = await response.blob();
          if (blob.type !== mimeType) {
            throw new TypeError(`Expected ${mimeType}, got ${blob.type}`);
          }
          if (
            !navigator.clipboard?.write ||
            typeof ClipboardItem === "undefined"
          ) {
            throw new DOMException(
              "Image clipboard writes are unavailable in this document",
              "NotSupportedError",
            );
          }
          await navigator.clipboard.write([
            new ClipboardItem({ [mimeType]: blob }),
          ]);
          return { ok: true };
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
      args: [workflow.item.dataUrl, workflow.item.mimeType],
    });

    if (injection?.result?.ok === true) return true;
    throw new Error(
      injection?.result?.error ??
        "The active tab returned no clipboard result",
    );
  } catch (error) {
    console.warn("Sotto automatic screenshot copy failed", error);
    return false;
  }
}

async function publishActionResult(
  transcript: string,
  command: ActionCommand,
  result: ActionResult,
  generation: number,
): Promise<void> {
  if (!commandIsCurrent(generation)) return;
  if (command.action === "notes") {
    await publishNotes();
    if (!commandIsCurrent(generation)) return;
  }
  if (result.pageText) {
    const { text, title, lang, speech } = result.pageText;
    if (
      typeof text !== "string" ||
      !text.trim() ||
      text.length > 120_000 ||
      (title !== undefined &&
        (typeof title !== "string" || title.length > 600)) ||
      (lang !== undefined &&
        (typeof lang !== "string" || lang.length > 35)) ||
      (speech !== "short" && speech !== "long")
    ) {
      throw new TypeError("Rejected invalid page-derived presentation text");
    }
    await sendPanel({
      type: "page-text",
      text,
      ...(title === undefined ? {} : { title }),
    });
    if (!commandIsCurrent(generation)) return;
    await sendPanel({ type: "earcon", kind: "complete" });
    await sendPanel({
      type: "action-log",
      heard: transcript,
      did: result.spoken,
    });
    if (!commandIsCurrent(generation)) return;
    const speechLanguage = safeTtsLanguage(lang);
    if (speech === "long") {
      await tts.speakLong(text, {
        lang: speechLanguage,
        onProgress(progress) {
          if (!commandIsCurrent(generation)) return;
          void sendPanel({
            type: "reading-progress",
            current: progress.charIndex,
            total: progress.totalChars,
          });
        },
      });
    } else {
      await tts.speak(text, { lang: speechLanguage });
    }
    return;
  }
  if (result.workflow?.kind === "screenshot-permission") {
    await sendPanel({
      type: "screenshot-permission-needed",
      workflow: result.workflow,
    });
  }
  if (
    result.workflow?.kind === "clipboard-write"
  ) {
    registerClipboardWorkflow(result.workflow);
    if (await writeClipboardInActiveTab(result.workflow)) {
      await completeClipboardWorkflow({
        workflowId: result.workflow.id,
      });
      return;
    }
  }
  await sendOffscreen({
    type: "action-result",
    transcript,
    command,
    result,
  });
}

async function executeCommand(
  command: unknown,
  transcript: string,
  generation: number,
): Promise<ActionResult | undefined> {
  try {
    const validated = commandRouter.parse(command);
    const result = await commandRouter.route(validated, {
      dispatchDestination: (id, input) =>
        destinationRegistry.dispatch(id, input),
      page: pageActionServices,
      type: editableActionServices,
    });
    if (!commandIsCurrent(generation)) return undefined;
    await publishActionResult(transcript, validated, result, generation);
    return result;
  } catch (error) {
    if (!commandIsCurrent(generation)) return undefined;
    const rejected = error instanceof CommandValidationError;
    const actionId =
      typeof command === "object" &&
      command !== null &&
      !Array.isArray(command) &&
      typeof (command as { action?: unknown }).action === "string"
        ? (command as { action: string }).action
        : "";
    const spoken = rejected
      ? "Sorry, say that again?"
      : actionId === "type"
        ? "I couldn't safely type in that editor."
      : "That action could not be completed.";
    const detail = error instanceof Error ? error.message : String(error);
    console.warn("Sotto command failed", error);
    await sendOffscreen({
      type: "action-error",
      transcript,
      spoken,
      detail: rejected ? "rejected invalid command" : detail,
    });
    return undefined;
  }
}

async function retryScreenshot(command: unknown): Promise<ActionResult> {
  const validated = commandRouter.parse(command);
  if (validated.action !== "screenshot") {
    throw new TypeError("Only a pending screenshot can be retried");
  }
  const result = await commandRouter.route(validated, {
    dispatchDestination: (id, input) =>
      destinationRegistry.dispatch(id, input),
  });
  if (result.workflow?.kind === "clipboard-write") {
    registerClipboardWorkflow(result.workflow);
  }
  return result;
}

async function handleWorkerMessage(message: WorkerMessage): Promise<unknown> {
  switch (message.type) {
    case "get-status":
      return sendOffscreen({ type: "get-status" });
    case "get-notes":
      return (await publishNotes()).map(panelNote);
    case "get-reminder": {
      if (
        typeof message.reminderId !== "string" ||
        !REMINDER_ID_PATTERN.test(message.reminderId)
      ) {
        throw new TypeError("A valid reminder id is required");
      }
      const reminder = await loadReminder(`reminder:${message.reminderId}`);
      return reminder === undefined
        ? undefined
        : {
            id: reminder.id,
            text: reminder.text,
            dueAt: reminder.dueAt,
          };
    }
    case "export-notes":
      return createNotesMarkdownExport(
        await notesReminderStore.listNotes(),
      );
    case "start-listening":
      beginCommandGeneration();
      return sendOffscreen({ type: "start-listening" });
    case "stop-listening":
      return sendOffscreen({ type: "stop-listening" });
    case "toggle-listening":
      beginCommandGeneration();
      return sendOffscreen({ type: "toggle-listening" });
    case "text-command": {
      beginCommandGeneration();
      const text = safeTranscript(message.text);
      if (!text) throw new TypeError("A non-empty text command is required");
      return sendOffscreen({ type: "parse-transcript", transcript: text });
    }
    case "execute-command": {
      const generation = beginCommandGeneration();
      const transcript = safeTranscript(message.transcript);
      return executeCommand(message.command, transcript, generation);
    }
    case "retry-screenshot":
      return retryScreenshot(message.command);
    case "speak": {
      const text = safeTranscript(message.text);
      if (text) {
        try {
          await tts.speak(text, { lang: "en-US" });
        } catch (error) {
          const detail = errorMessage(error);
          console.warn("Sotto speech feedback failed", error);
          await sendPanel({
            type: "pipeline-error",
            message: `Speech feedback unavailable: ${detail}`,
          });
        }
      }
      return undefined;
    }
    case "open-microphone-page":
      await chrome.tabs.create({
        url: chrome.runtime.getURL("request-mic.html"),
      });
      return undefined;
    case "microphone-granted":
      return sendOffscreen({ type: "refresh-permissions" });
    case "nano-ready":
      return sendOffscreen({ type: "nano-ready" });
    case "prepare-premium-tts":
      return sendOffscreen({ type: "prepare-premium-tts" });
    case "set-premium-tts-enabled":
      if (typeof message.enabled !== "boolean") {
        throw new TypeError("A premium voice enabled setting is required");
      }
      return sendOffscreen({
        type: "set-premium-tts-enabled",
        enabled: message.enabled,
      });
    case "prepare-premium-stt":
      return sendOffscreen({ type: "prepare-premium-stt" });
    case "set-premium-stt-enabled":
      if (typeof message.enabled !== "boolean") {
        throw new TypeError(
          "A high-accuracy speech enabled setting is required",
        );
      }
      return sendOffscreen({
        type: "set-premium-stt-enabled",
        enabled: message.enabled,
      });
    case "premium-first-audio":
      if (
        typeof message.utteranceId !== "string" ||
        message.utteranceId.length > 160
      ) {
        throw new TypeError("A valid premium utterance id is required");
      }
      tts.notifyFirstAudio(message.utteranceId);
      return undefined;
    case "premium-state-update": {
      if (
        message.state !== "absent" &&
        message.state !== "downloading" &&
        message.state !== "ready" &&
        message.state !== "error"
      ) {
        throw new TypeError("A valid premium voice state is required");
      }
      if (typeof message.enabled !== "boolean") {
        throw new TypeError("A premium voice enabled setting is required");
      }
      const backend =
        message.backend === "webgpu" || message.backend === "wasm"
          ? message.backend
          : undefined;
      const error =
        typeof message.error === "string"
          ? message.error.slice(0, 1_000)
          : undefined;
      tts.updateStatus({
        state: message.state as PremiumTtsState,
        enabled: message.enabled,
        ...(backend === undefined ? {} : { backend }),
        ...(error === undefined ? {} : { error }),
      });
      return undefined;
    }
    case "clipboard-complete": {
      await completeClipboardWorkflow(
        parseClipboardWorkflowCompletion(message.completion),
      );
      return undefined;
    }
    default:
      throw new TypeError(`Unsupported worker message type: ${message.type}`);
  }
}

chrome.runtime.onMessage.addListener(
  (raw: unknown, _sender, sendResponse): boolean | void => {
    if (
      typeof raw !== "object" ||
      raw === null ||
      Array.isArray(raw) ||
      (raw as { target?: unknown }).target !== "worker"
    ) {
      return;
    }

    void handleWorkerMessage(raw as WorkerMessage)
      .then((value) => sendResponse({ ok: true, value }))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        sendResponse({ ok: false, error: { name: "Error", message } });
        void sendPanel({ type: "pipeline-error", message });
      });
    return true;
  },
);

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== "toggle-sotto") return;
  beginCommandGeneration();
  let panelOpening: Promise<void> = Promise.resolve();
  if (tab?.id !== undefined) {
    panelOpening = chrome.sidePanel.open({ tabId: tab.id });
  } else if (tab?.windowId !== undefined) {
    panelOpening = chrome.sidePanel.open({ windowId: tab.windowId });
  }
  runAndReport(
    panelOpening
      .catch((error: unknown) =>
        reportBackgroundFailure("Sotto could not open the side panel", error),
      )
      .then(() => sendOffscreen({ type: "toggle-listening" })),
    "Sotto could not toggle listening",
    "I couldn't start listening. Open Sotto to check microphone access.",
  );
});

chrome.runtime.onInstalled.addListener(() => {
  runAndReport(
    chrome.sidePanel.setPanelBehavior({
      openPanelOnActionClick: true,
    }),
    "Sotto could not configure its side panel",
  );
  runAndReport(
    restrictNotesStorageAccess().then(reconcileReminders),
    "Sotto could not initialize notes and reminders",
  );
});

chrome.runtime.onStartup?.addListener(() => {
  runAndReport(
    restrictNotesStorageAccess().then(reconcileReminders),
    "Sotto could not reconcile reminders",
  );
});

chrome.alarms?.onAlarm?.addListener((alarm) => {
  runAndReport(
    notesReminderStore.handleReminderAlarm(alarm.name, {
      onDue: deliverReminder,
    }),
    "Sotto could not deliver a reminder",
  );
});

chrome.notifications?.onClicked?.addListener((notificationId) => {
  const parsed = parseReminderNotificationId(notificationId);
  if (!parsed) return;

  // The open call is initiated in the notification click's first synchronous
  // turn so Chrome can preserve the user gesture.
  const targetWindowId =
    parsed.sourceWindowId ?? chrome.windows.WINDOW_ID_CURRENT;
  let panelOpening: Promise<void>;
  try {
    panelOpening = chrome.sidePanel.open({ windowId: targetWindowId });
  } catch (error) {
    panelOpening = Promise.reject(error);
  }
  runAndReport(
    (async () => {
      const reminder = await loadReminder(parsed.reminderKey);
      if (reminder?.sourceWindowId !== undefined) {
        await chrome.windows
          .update(reminder.sourceWindowId, {
            focused: true,
          })
          .catch(() => undefined);
      }
      if (reminder?.sourceTabId !== undefined) {
        await chrome.tabs
          .update(reminder.sourceTabId, { active: true })
          .catch(() => undefined);
      }
      try {
        await panelOpening;
      } catch (error) {
        console.warn(
          "Sotto could not open the reminder in the side panel; opening an extension page",
          error,
        );
        const fallbackUrl = chrome.runtime.getURL(
          `sidepanel.html#reminder=${encodeURIComponent(parsed.reminderId)}`,
        );
        try {
          await chrome.tabs.create({
            url: fallbackUrl,
            active: true,
            ...(reminder?.sourceWindowId === undefined
              ? {}
              : { windowId: reminder.sourceWindowId }),
          });
        } catch {
          await chrome.tabs.create({ url: fallbackUrl, active: true });
        }
      }
      await chrome.notifications.clear(notificationId);
      if (reminder) {
        await sendPanel({
          type: "reminder-opened",
          reminder: {
            id: reminder.id,
            text: reminder.text,
            dueAt: reminder.dueAt,
          },
        });
      }
    })(),
    "Sotto could not open the reminder",
  );
});

if (chrome.storage?.local && chrome.alarms && chrome.notifications) {
  runAndReport(
    restrictNotesStorageAccess().then(reconcileReminders),
    "Sotto could not restore reminders",
  );
}
