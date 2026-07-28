import actions from "@sotto/actions";
import {
  ActionRegistry,
  CommandRouter,
  CommandValidationError,
  DestinationRegistry,
  type ActionCommand,
  type ActionResult,
  type DestinationFollowUp,
} from "@sotto/core";
import destinations, {
  executeDestinationFollowUp,
} from "@sotto/destinations";
import { SystemTtsEngine } from "@sotto/tts";

interface WorkerMessage {
  readonly target: "worker";
  readonly type: string;
  readonly text?: unknown;
  readonly command?: unknown;
  readonly transcript?: unknown;
  readonly completion?: unknown;
}

const actionRegistry = new ActionRegistry(actions);
const destinationRegistry = new DestinationRegistry(destinations);
const commandRouter = new CommandRouter(actionRegistry);
const tts = new SystemTtsEngine();

let creatingOffscreen: Promise<void> | undefined;

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
        "Capture microphone audio locally and play short Web Audio earcons",
    });
  }

  try {
    await creatingOffscreen;
  } finally {
    creatingOffscreen = undefined;
  }
}

async function sendOffscreen(message: Record<string, unknown>): Promise<unknown> {
  await ensureOffscreen();
  const response = (await chrome.runtime.sendMessage({
    target: "offscreen",
    ...message,
  })) as
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

async function sendPanel(message: Record<string, unknown>): Promise<void> {
  try {
    await chrome.runtime.sendMessage({ target: "sidepanel", ...message });
  } catch {
    // The panel is intentionally optional; hotkey voice commands still work.
  }
}

function safeTranscript(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 2_000) : "";
}

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

async function publishActionResult(
  transcript: string,
  command: ActionCommand,
  result: ActionResult,
): Promise<void> {
  if (result.workflow?.kind === "clipboard-write") {
    await sendPanel({
      type: "screenshot-ready",
      workflow: result.workflow,
    });
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
): Promise<void> {
  try {
    const validated = commandRouter.parse(command);
    const result = await commandRouter.route(validated, {
      dispatchDestination: (id, input) =>
        destinationRegistry.dispatch(id, input),
    });
    await publishActionResult(transcript, validated, result);
  } catch (error) {
    const rejected = error instanceof CommandValidationError;
    const spoken = rejected
      ? "Sorry, say that again?"
      : "That action could not be completed.";
    const detail = error instanceof Error ? error.message : String(error);
    console.warn("Sotto command failed", error);
    await sendOffscreen({
      type: "action-error",
      transcript,
      spoken,
      detail: rejected ? "rejected invalid command" : detail,
    });
  }
}

async function handleWorkerMessage(message: WorkerMessage): Promise<unknown> {
  switch (message.type) {
    case "get-status":
      return sendOffscreen({ type: "get-status" });
    case "start-listening":
      return sendOffscreen({ type: "start-listening" });
    case "stop-listening":
      return sendOffscreen({ type: "stop-listening" });
    case "toggle-listening":
      return sendOffscreen({ type: "toggle-listening" });
    case "text-command": {
      const text = safeTranscript(message.text);
      if (!text) throw new TypeError("A non-empty text command is required");
      return sendOffscreen({ type: "parse-transcript", transcript: text });
    }
    case "execute-command": {
      const transcript = safeTranscript(message.transcript);
      await executeCommand(message.command, transcript);
      return undefined;
    }
    case "get-open-tabs": {
      const tabs = await chrome.tabs.query({});
      return {
        tabs: tabs.flatMap((tab) =>
          tab.id === undefined
            ? []
            : [
                {
                  id: tab.id,
                  title: tab.title ?? "",
                  url: tab.url ?? "",
                },
              ],
        ),
      };
    }
    case "speak": {
      const text = safeTranscript(message.text);
      if (text) await tts.speak(text, { lang: "en-US" });
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
    case "clipboard-complete": {
      const completion =
        typeof message.completion === "object" && message.completion !== null
          ? (message.completion as {
              followUp?: unknown;
              spoken?: unknown;
            })
          : {};
      if (completion.followUp !== undefined) {
        if (!isAllowedFollowUp(completion.followUp)) {
          throw new TypeError("Rejected an invalid destination follow-up");
        }
        await executeDestinationFollowUp(completion.followUp);
      }
      const spoken =
        typeof completion.spoken === "string"
          ? completion.spoken.slice(0, 240)
          : "Screenshot copied.";
      await sendPanel({
        type: "action-log",
        heard: "copy screenshot",
        did: completion.followUp ? "copied and opened Claude" : "copied",
      });
      await sendOffscreen({
        type: "workflow-complete",
        spoken,
      });
      return undefined;
    }
    default:
      return undefined;
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
  if (tab?.id !== undefined) {
    void chrome.sidePanel.open({ tabId: tab.id });
  } else if (tab?.windowId !== undefined) {
    void chrome.sidePanel.open({ windowId: tab.windowId });
  }
  void sendOffscreen({ type: "toggle-listening" });
});

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({
    openPanelOnActionClick: true,
  });
});
