import actions from "@sotto/actions";
import { createNotesMarkdownExport } from "@sotto/actions/notes/markdown";
import type {
  PlaybackCommand,
  PlaybackOperation,
} from "@sotto/actions/playback";
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
  type ActionContext,
  type ActionResult,
  type ClipboardWorkflow,
  type DestinationFollowUp,
  type DictationActionServices,
  type EditableActionServices,
  type ExtractedPageText,
  type PageActionServices,
  type PageModelTask,
} from "@sotto/core";
import destinations, {
  executeDestinationFollowUp,
  type ClipboardWorkflowCompletion,
} from "@sotto/destinations";
import {
  SystemTtsEngine,
  type TtsLongSpeakOptions,
  type TtsSpeakOptions,
} from "@sotto/tts";
import {
  isKokoroVoiceId,
  type KokoroVoiceId,
} from "@sotto/tts/kokoro";
import {
  PremiumTtsRouter,
  previewPremiumVoiceSelection,
  type PremiumTtsState,
} from "./premium-tts.js";
import {
  isExchangeTimings,
  type ExchangeTimings,
} from "./timings.js";
import { createCommandReference } from "./command-reference.js";
import {
  SpeechSettingsStore,
  SpeechSettingsTtsEngine,
} from "./speech-settings.js";
import {
  DictationTargetSession,
  type DictationTarget,
} from "./dictation.js";
import { ConfirmationSession } from "./confirmation.js";

interface WorkerMessage {
  readonly target: "worker";
  readonly type: string;
  readonly text?: unknown;
  readonly command?: unknown;
  readonly transcript?: unknown;
  readonly completion?: unknown;
  readonly reminderId?: unknown;
  readonly noteId?: unknown;
  readonly utteranceId?: unknown;
  readonly state?: unknown;
  readonly enabled?: unknown;
  readonly voice?: unknown;
  readonly backend?: unknown;
  readonly error?: unknown;
  readonly rate?: unknown;
  readonly volume?: unknown;
  readonly heard?: unknown;
  readonly did?: unknown;
  readonly timings?: unknown;
  readonly operation?: unknown;
}

const actionRegistry = new ActionRegistry(actions);
const destinationRegistry = new DestinationRegistry(destinations);
const commandRouter = new CommandRouter(actionRegistry);
const systemTts = new SystemTtsEngine();
const ttsRouter = new PremiumTtsRouter({
  system: systemTts,
  request: (request) => sendOffscreen({ ...request }),
});
const speechSettings = new SpeechSettingsStore({
  get: async (keys) => await chrome.storage.local.get([...keys]),
  set: async (values) => await chrome.storage.local.set(values),
});
const tts = new SpeechSettingsTtsEngine(ttsRouter, speechSettings);
const confirmationSession = new ConfirmationSession();

let creatingOffscreen: Promise<void> | undefined;
let commandGeneration = 0;
let readingActive = false;
let readingPaused = false;
let lastSpokenResponse: string | undefined;
const dictationSession = new DictationTargetSession();

function actionContext(): ActionContext {
  return {
    dispatchDestination: (id, input) =>
      destinationRegistry.dispatch(id, input),
    page: pageActionServices,
    type: editableActionServices,
    dictation: dictationActionServices,
    actionCatalog: actionRegistry,
  };
}

async function speakResponse(
  text: string,
  options: TtsSpeakOptions = {},
  remember = true,
): Promise<void> {
  await tts.speak(text, options);
  if (remember) lastSpokenResponse = text;
}

async function speakLongResponse(
  text: string,
  options: TtsLongSpeakOptions = {},
): Promise<void> {
  await tts.speakLong(text, options);
  lastSpokenResponse = text;
}

function beginCommandGeneration(): number {
  commandGeneration += 1;
  const stoppedReading = readingActive;
  readingActive = false;
  readingPaused = false;
  tts.stop();
  if (stoppedReading) {
    void sendPanel({
      type: "reading-state",
      active: false,
      paused: false,
    });
  }
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
        !/Receiving end does not exist|message port closed|Could not establish connection/i
          .test(detail) ||
        attempt === 2
      ) {
        throw error;
      }
      // Creation can beat listener registration, and Chrome can close a response
      // port while recreating an interrupted offscreen document.
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

async function speakAndPublishActionLog(
  heard: string,
  did: string,
  timings: ExchangeTimings,
  speak: (onFirstAudio: () => void) => Promise<void>,
): Promise<void> {
  const speakStartedAt = performance.now();
  let publication: Promise<boolean> | undefined;
  const publish = (voiceMs?: number): Promise<boolean> => {
    publication ??= sendPanel({
      type: "action-log",
      heard,
      did,
      timings:
        voiceMs === undefined
          ? timings
          : { ...timings, voiceMs },
    });
    return publication;
  };

  try {
    await speak(() => {
      void publish(Math.max(0, performance.now() - speakStartedAt));
    });
  } finally {
    await publish();
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
      await speakResponse(spoken, { lang: "en-US" });
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

function firstWords(text: string, maximum = 8): string {
  const words = text.trim().split(/\s+/u);
  const wordPreview = words
    .slice(0, maximum)
    .join(" ")
    .replace(/[.!?]+$/u, "");
  const preview = wordPreview.slice(0, 80).trimEnd();
  return words.length > maximum || preview.length < wordPreview.length
    ? `${preview}…`
    : preview;
}

async function confirmationResult(
  command: ActionCommand,
): Promise<{ readonly result: ActionResult; readonly pending: boolean }> {
  if (
    command.action === "notes" &&
    (command as { readonly operation?: unknown }).operation === "delete-last"
  ) {
    const note = (await notesReminderStore.listNotes())[0];
    if (!note) {
      return {
        result: { spoken: "You have no notes." },
        pending: false,
      };
    }
    return {
      result: {
        spoken: `Delete the note: ${firstWords(note.body)}? Say yes.`,
      },
      pending: true,
    };
  }

  const title = actionRegistry.get(command.action)?.title ?? command.action;
  return {
    result: { spoken: `Run ${title}? Say yes.` },
    pending: true,
  };
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
    await speakResponse(`Reminder: ${reminder.text}`, { lang: "en-US" });
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

interface FocusedEditorCapture {
  readonly capture: ReturnType<typeof parseEditorCapture>;
  readonly location: Omit<EditorBridgeLocation, "bridgeSnapshotId">;
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
  readonly targetId: string;
  readonly selectedText: string;
  readonly source: "caret" | "selection" | "last-dictated";
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("The editor bridge returned invalid capture data");
  }
  const capture = value as {
    snapshotId?: unknown;
    targetId?: unknown;
    selectedText?: unknown;
    source?: unknown;
  };
  if (
    typeof capture.snapshotId !== "string" ||
    typeof capture.targetId !== "string" ||
    capture.targetId.length < 1 ||
    capture.targetId.length > 256 ||
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
    targetId: capture.targetId,
    selectedText: capture.selectedText,
    source: capture.source,
  };
}

async function findFocusedEditable(
  options: Parameters<EditableActionServices["capture"]>[0],
): Promise<FocusedEditorCapture> {
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

  const captures: FocusedEditorCapture[] = [];
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

  return captures[0]!;
}

async function captureEditable(
  options: Parameters<EditableActionServices["capture"]>[0],
): ReturnType<EditableActionServices["capture"]> {
  const selected = await findFocusedEditable(options);
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

function dictationTargetFrom(
  capture: ReturnType<typeof parseEditorCapture>,
  location: Omit<EditorBridgeLocation, "bridgeSnapshotId">,
): DictationTarget {
  return {
    tabId: location.tabId,
    frameId: location.frameId,
    ...(location.documentId === undefined
      ? {}
      : { documentId: location.documentId }),
    targetId: capture.targetId,
  };
}

async function releaseDictationTarget(
  target: DictationTarget | undefined,
): Promise<void> {
  if (!target) return;
  try {
    await chrome.tabs.sendMessage(
      target.tabId,
      {
        target: "sotto-type-bridge",
        type: "release",
      },
      bridgeMessageOptions(target),
    );
  } catch {
    // A closed or navigated tab has no bridge to release.
  }
}

async function captureCurrentDictationTarget(): Promise<{
  readonly capture: ReturnType<typeof parseEditorCapture>;
  readonly location: EditorBridgeLocation;
  readonly target: DictationTarget;
}> {
  const expected = dictationSession.target;
  if (!expected) throw new Error("Dictation is not active.");
  const [activeTab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  if (activeTab?.id !== expected.tabId) {
    throw new Error("The active tab changed.");
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: expected.tabId, frameIds: [expected.frameId] },
      files: ["typeBridge.js"],
      world: "ISOLATED",
    });
    const raw = (await chrome.tabs.sendMessage(
      expected.tabId,
      {
        target: "sotto-type-bridge",
        type: "capture",
        options: {
          requireSelection: false,
          allowLastDictated: false,
        },
        keepAlive: true,
      },
      bridgeMessageOptions(expected),
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
          : "The text field is not ready.",
      );
    }
    const capture = parseEditorCapture(raw.value);
    const location: EditorBridgeLocation = {
      tabId: expected.tabId,
      frameId: expected.frameId,
      ...(expected.documentId === undefined
        ? {}
        : { documentId: expected.documentId }),
      bridgeSnapshotId: capture.snapshotId,
    };
    return {
      capture,
      location,
      target: dictationTargetFrom(capture, location),
    };
  } catch (error) {
    throw new Error(
      error instanceof Error ? error.message : "The text field changed.",
    );
  }
}

async function startDictation(): Promise<string> {
  const selected = await findFocusedEditable({
    requireSelection: false,
    allowLastDictated: false,
  });
  const previous = dictationSession.stop();
  await releaseDictationTarget(previous);
  dictationSession.start(
    dictationTargetFrom(selected.capture, selected.location),
  );
  const spoken = "Dictation started.";
  try {
    await speakResponse(spoken, { lang: "en-US" });
    await sendOffscreen({ type: "dictation-start" });
    return spoken;
  } catch (error) {
    await releaseDictationTarget(dictationSession.stop());
    throw error;
  }
}

async function stopDictation(
  spoken = "Dictation stopped.",
  notifyOffscreen = true,
): Promise<string> {
  const target = dictationSession.stop();
  if (!target) {
    const inactive = "Dictation is not active.";
    await speakResponse(inactive, { lang: "en-US" });
    return inactive;
  }
  if (notifyOffscreen) {
    await sendOffscreen({ type: "dictation-stop" });
  }
  await releaseDictationTarget(target);
  await speakResponse(spoken, { lang: "en-US" });
  return spoken;
}

async function insertDictationText(
  text: string,
): Promise<{ readonly status: "inserted" | "paused" }> {
  if (dictationSession.state !== "active") return { status: "paused" };
  try {
    const current = await captureCurrentDictationTarget();
    if (!dictationSession.validate(current.target)) {
      return { status: "paused" };
    }
    const raw = (await chrome.tabs.sendMessage(
      current.location.tabId,
      {
        target: "sotto-type-bridge",
        type: "commit",
        snapshotId: current.location.bridgeSnapshotId,
        text,
        inputType:
          current.capture.source === "selection"
            ? "insertReplacementText"
            : "insertText",
        rememberAsDictation: true,
        keepAlive: true,
      },
      bridgeMessageOptions(current.location),
    )) as
      | {
          readonly ok?: unknown;
          readonly value?: unknown;
        }
      | undefined;
    if (raw?.ok !== true) throw new Error("The text field changed.");
    return { status: "inserted" };
  } catch {
    dictationSession.pause();
    return { status: "paused" };
  }
}

async function resumeDictation(): Promise<boolean> {
  if (dictationSession.state !== "paused") return false;
  try {
    const current = await captureCurrentDictationTarget();
    if (!dictationSession.resume(current.target)) throw new Error();
    await sendOffscreen({ type: "dictation-resume" });
    return true;
  } catch {
    const spoken = "Focus the same text field, then select Resume.";
    await speakResponse(spoken, { lang: "en-US" });
    await sendPanel({
      type: "dictation-state",
      active: true,
      paused: true,
    });
    return false;
  }
}

const dictationActionServices: DictationActionServices = {
  start: startDictation,
  stop: () => stopDictation(),
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
  timings: ExchangeTimings,
): Promise<void> {
  if (!commandIsCurrent(generation)) return;
  if (command.action === "notes") {
    await publishNotes();
    if (!commandIsCurrent(generation)) return;
  }
  if (result.silent === true) {
    await sendPanel({
      type: "action-log",
      heard: transcript,
      did: result.spoken,
      timings,
    });
    return;
  }
  if (result.replayLastSpoken === true) {
    if (command.action !== "repeat") {
      throw new TypeError("Only repeat can replay worker speech");
    }
    const spoken = lastSpokenResponse ?? result.spoken;
    await sendPanel({ type: "earcon", kind: "complete" });
    await speakAndPublishActionLog(
      transcript,
      lastSpokenResponse === undefined
        ? result.spoken
        : "Repeated the last response.",
      timings,
      (onFirstAudio) =>
        speakResponse(
          spoken,
          {
            lang: "en-US",
            onFirstAudio,
          },
          false,
        ),
    );
    return;
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
    if (!commandIsCurrent(generation)) return;
    const speechLanguage = safeTtsLanguage(lang);
    if (speech === "long") {
      readingActive = true;
      readingPaused = false;
      await sendPanel({
        type: "reading-state",
        active: true,
        paused: false,
      });
      try {
        await speakAndPublishActionLog(
          transcript,
          result.spoken,
          timings,
          (onFirstAudio) =>
            speakLongResponse(text, {
              lang: speechLanguage,
              onFirstAudio,
              onProgress(progress) {
                if (!commandIsCurrent(generation)) return;
                void sendPanel({
                  type: "reading-progress",
                  current: progress.charIndex,
                  total: progress.totalChars,
                });
              },
            }),
        );
      } finally {
        if (commandIsCurrent(generation)) {
          readingActive = false;
          readingPaused = false;
          await sendPanel({
            type: "reading-state",
            active: false,
            paused: false,
          });
        }
      }
    } else {
      await speakAndPublishActionLog(
        transcript,
        result.spoken,
        timings,
        (onFirstAudio) =>
          speakResponse(text, {
            lang: speechLanguage,
            onFirstAudio,
          }),
      );
    }
    return;
  }
  if (result.workflow?.kind === "screenshot-permission") {
    await sendPanel({
      type: "screenshot-permission-needed",
      workflow: result.workflow,
    });
  }
  if (result.workflow?.kind === "panel-command-reference") {
    await sendPanel({ type: "show-command-reference" });
    await sendPanel({ type: "earcon", kind: "complete" });
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
    timings,
  });
}

function isPlaybackOperation(value: unknown): value is PlaybackOperation {
  return (
    value === "pause" ||
    value === "resume" ||
    value === "stop" ||
    value === "skip"
  );
}

async function publishPlaybackResult(
  transcript: string,
  did: string,
  timings: ExchangeTimings,
): Promise<void> {
  await sendPanel({
    type: "action-log",
    heard: transcript,
    did,
    timings,
  });
}

async function executePlaybackCommand(
  command: PlaybackCommand,
  transcript: string,
  timings: ExchangeTimings,
): Promise<ActionResult> {
  const operation = command.operation;
  if (operation !== "stop" && !readingActive) {
    const spoken = "Sorry, say that again?";
    await speakAndPublishActionLog(
      transcript,
      spoken,
      timings,
      (onFirstAudio) =>
        speakResponse(spoken, {
          lang: "en-US",
          onFirstAudio,
        }),
    );
    return { spoken };
  }

  if (operation === "stop") {
    readingActive = false;
    readingPaused = false;
    tts.stop();
  } else if (operation === "pause") {
    if (!readingPaused) tts.pause();
    readingPaused = true;
  } else if (operation === "resume") {
    if (readingPaused) tts.resume();
    readingPaused = false;
  } else {
    tts.skip();
  }

  const spoken = operation === "pause"
    ? "Reading paused."
    : operation === "resume"
      ? "Reading resumed."
      : operation === "skip"
        ? "Skipped one sentence."
        : "Reading stopped.";
  await sendPanel({
    type: "reading-state",
    active: readingActive,
    paused: readingPaused,
  });
  await publishPlaybackResult(transcript, spoken, timings);
  return { spoken };
}

async function executeCommand(
  command: unknown,
  transcript: string,
  timings: ExchangeTimings,
): Promise<ActionResult | undefined> {
  let completedTimings = timings;
  let generation = commandGeneration;
  let generationStarted = false;
  try {
    const confirmation = confirmationSession.resolve(transcript);
    if (confirmation.kind === "cancelled") {
      generation = beginCommandGeneration();
      generationStarted = true;
      const result = { spoken: "Cancelled." };
      await publishActionResult(
        transcript,
        { action: "unknown" },
        result,
        generation,
        timings,
      );
      return result;
    }
    if (confirmation.kind === "confirmed") {
      generation = beginCommandGeneration();
      generationStarted = true;
      const actionStartedAt = performance.now();
      let result: ActionResult;
      try {
        result = await commandRouter.routeConfirmed(
          confirmation.command,
          actionContext(),
        );
      } finally {
        completedTimings = {
          ...timings,
          actionMs: Math.max(0, performance.now() - actionStartedAt),
        };
      }
      if (!commandIsCurrent(generation)) return undefined;
      await publishActionResult(
        transcript,
        confirmation.command,
        result,
        generation,
        completedTimings,
      );
      return result;
    }

    const validated = commandRouter.parse(command);
    if (validated.action === "playback") {
      const operation = (validated as { readonly operation?: unknown })
        .operation;
      if (!isPlaybackOperation(operation)) {
        throw new CommandValidationError("Invalid playback operation");
      }
      return await executePlaybackCommand(
        validated as PlaybackCommand,
        transcript,
        timings,
      );
    }
    generation = beginCommandGeneration();
    generationStarted = true;
    const actionStartedAt = performance.now();
    let result: ActionResult;
    try {
      if (commandRouter.requiresConfirmation(validated)) {
        const request = await confirmationResult(validated);
        if (request.pending) confirmationSession.request(validated);
        result = request.result;
      } else {
        result = await commandRouter.route(validated, actionContext());
      }
    } finally {
      completedTimings = {
        ...timings,
        actionMs: Math.max(0, performance.now() - actionStartedAt),
      };
    }
    if (!commandIsCurrent(generation)) return undefined;
    await publishActionResult(
      transcript,
      validated,
      result,
      generation,
      completedTimings,
    );
    return result;
  } catch (error) {
    if (!generationStarted) {
      generation = beginCommandGeneration();
    }
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
      : actionId === "dictation"
        ? "Focus a text field before you start dictation."
      : "That action could not be completed.";
    const detail = error instanceof Error ? error.message : String(error);
    console.warn("Sotto command failed", error);
    await sendOffscreen({
      type: "action-error",
      transcript,
      spoken,
      detail: rejected ? "rejected invalid command" : detail,
      timings: completedTimings,
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
    case "get-speech-settings":
      return speechSettings.get();
    case "set-speech-settings": {
      const update: { rate?: number; volume?: number } = {};
      if (message.rate !== undefined) {
        if (
          typeof message.rate !== "number" ||
          !Number.isFinite(message.rate)
        ) {
          throw new TypeError("A valid speech rate is required");
        }
        update.rate = message.rate;
      }
      if (message.volume !== undefined) {
        if (
          typeof message.volume !== "number" ||
          !Number.isFinite(message.volume)
        ) {
          throw new TypeError("A valid speech volume is required");
        }
        update.volume = message.volume;
      }
      if (update.rate === undefined && update.volume === undefined) {
        throw new TypeError("A speech setting is required");
      }
      return speechSettings.update(update);
    }
    case "get-notes":
      return (await publishNotes()).map(panelNote);
    case "delete-note": {
      if (
        typeof message.noteId !== "string" ||
        !REMINDER_ID_PATTERN.test(message.noteId)
      ) {
        throw new TypeError("A valid note id is required");
      }
      const deleted = await notesReminderStore.deleteNote(message.noteId);
      await publishNotes();
      return deleted;
    }
    case "get-command-reference":
      return createCommandReference(actionRegistry);
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
      if (!readingActive) beginCommandGeneration();
      return sendOffscreen({ type: "start-listening" });
    case "stop-listening":
      return sendOffscreen({ type: "stop-listening" });
    case "stop-dictation":
      return stopDictation();
    case "dictation-exit": {
      const spoken = message.operation === "silence"
        ? "Dictation stopped after 60 seconds of silence."
        : "Dictation stopped.";
      return stopDictation(spoken, false);
    }
    case "dictation-insert": {
      if (
        typeof message.text !== "string" ||
        message.text.length < 1 ||
        message.text.length > 2_000
      ) {
        throw new TypeError("Valid dictation text is required");
      }
      return insertDictationText(message.text);
    }
    case "resume-dictation":
      return resumeDictation();
    case "stop-reading":
      beginCommandGeneration();
      return undefined;
    case "playback-control": {
      if (!isPlaybackOperation(message.operation)) {
        throw new TypeError("A valid playback operation is required");
      }
      return executePlaybackCommand(
        { action: "playback", operation: message.operation },
        message.operation === "skip"
          ? "skip"
          : `${message.operation} reading`,
        { input: "typed" },
      );
    }
    case "toggle-listening":
      if (dictationSession.state !== "inactive") {
        return stopDictation();
      }
      if (!readingActive) beginCommandGeneration();
      return sendOffscreen({ type: "toggle-listening" });
    case "text-command": {
      if (!readingActive) beginCommandGeneration();
      const text = safeTranscript(message.text);
      if (!text) throw new TypeError("A non-empty text command is required");
      return sendOffscreen({
        type: "parse-transcript",
        transcript: text,
        timings: { input: "typed" },
      });
    }
    case "execute-command": {
      const transcript = safeTranscript(message.transcript);
      const timings = isExchangeTimings(message.timings)
        ? message.timings
        : { input: "voice" as const };
      return executeCommand(
        message.command,
        transcript,
        timings,
      );
    }
    case "retry-screenshot":
      return retryScreenshot(message.command);
    case "speak": {
      const text = safeTranscript(message.text);
      if (text) {
        try {
          const heard = safeTranscript(message.heard);
          const did = safeTranscript(message.did);
          if (heard && did && isExchangeTimings(message.timings)) {
            await speakAndPublishActionLog(
              heard,
              did,
              message.timings,
              (onFirstAudio) =>
                speakResponse(
                  text,
                  {
                    lang: "en-US",
                    onFirstAudio,
                  },
                ),
            );
          } else {
            await speakResponse(text, { lang: "en-US" });
          }
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
    case "preview-premium-tts-voice": {
      if (!isKokoroVoiceId(message.voice)) {
        throw new TypeError("A valid premium voice is required");
      }
      const voice: KokoroVoiceId = message.voice;
      const previousVoice = ttsRouter.voice;
      await previewPremiumVoiceSelection({
        voice,
        previousVoice,
        persist: async (nextVoice) => {
          await sendOffscreen({
            type: "set-premium-tts-voice",
            voice: nextVoice,
          });
        },
        speak: async (text, previewVoice) =>
          await ttsRouter.preview(
            text,
            previewVoice,
            await speechSettings.get(),
          ),
      });
      return undefined;
    }
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
      ttsRouter.notifyFirstAudio(message.utteranceId);
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
      const voice = isKokoroVoiceId(message.voice)
        ? message.voice
        : undefined;
      ttsRouter.updateStatus({
        state: message.state as PremiumTtsState,
        enabled: message.enabled,
        ...(voice === undefined ? {} : { voice }),
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
      .then(() =>
        dictationSession.state === "inactive"
          ? sendOffscreen({ type: "toggle-listening" })
          : stopDictation()
      ),
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
