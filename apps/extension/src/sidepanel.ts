import type {
  ActionResult,
  ClipboardWorkflow,
  ScreenshotPermissionWorkflow,
} from "@sotto/core";
import { performClipboardWorkflow } from "@sotto/destinations";
import { nextLogEntry, type LogEntry } from "./log.js";
import "./styles.css";

type NanoAvailability = "unavailable" | "downloadable" | "downloading" | "available";

type PanelMessage =
  | {
      target: "sidepanel";
      type: "engine-status";
      nano: NanoAvailability;
      listening: boolean;
      mic: PermissionState | "unknown";
      error?: string;
    }
  | { target: "sidepanel"; type: "listening-state"; listening: boolean }
  | { target: "sidepanel"; type: "speech-start" }
  | { target: "sidepanel"; type: "transcript"; text: string }
  | {
      target: "sidepanel";
      type: "model-progress";
      model: "nano" | "stt";
      progress: number;
      status?: string;
      file?: string;
    }
  | { target: "sidepanel"; type: "earcon"; kind: "listen" | "complete" }
  | { target: "sidepanel"; type: "action-log"; heard: string; did: string }
  | {
      target: "sidepanel";
      type: "screenshot-ready";
      workflow: ClipboardWorkflow;
    }
  | {
      target: "sidepanel";
      type: "screenshot-permission-needed";
      workflow: ScreenshotPermissionWorkflow;
    }
  | { target: "sidepanel"; type: "pipeline-error"; message: string };

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing UI element: ${selector}`);
  return element;
}

const statusChip = requiredElement<HTMLElement>("#status-chip");
const statusLabel = requiredElement<HTMLElement>("#status-label");
const onboarding = requiredElement<HTMLElement>("#onboarding");
const onboardingTitle = requiredElement<HTMLElement>("#onboarding-title");
const onboardingCopy = requiredElement<HTMLElement>("#onboarding-copy");
const prepareNano = requiredElement<HTMLButtonElement>("#prepare-nano");
const transcript = requiredElement<HTMLElement>("#transcript");
const listeningMark = requiredElement<HTMLElement>("#listening-mark");
const listenButton = requiredElement<HTMLButtonElement>("#listen-button");
const listenLabel = requiredElement<HTMLElement>("#listen-label");
const shortcutLabel = requiredElement<HTMLElement>("#shortcut-label");
const grantMic = requiredElement<HTMLButtonElement>("#grant-mic");
const commandForm = requiredElement<HTMLFormElement>("#command-form");
const commandInput = requiredElement<HTMLInputElement>("#command-input");
const clipboardCard = requiredElement<HTMLElement>("#clipboard-card");
const clipboardCopy = requiredElement<HTMLElement>("#clipboard-copy");
const copyScreenshot = requiredElement<HTMLButtonElement>("#copy-screenshot");
const actionLog = requiredElement<HTMLOListElement>("#action-log");
const clearLog = requiredElement<HTMLButtonElement>("#clear-log");
const nanoProgressCard = requiredElement<HTMLElement>("#nano-progress-card");
const nanoProgress = requiredElement<HTMLProgressElement>("#nano-progress");
const nanoProgressValue = requiredElement<HTMLOutputElement>("#nano-progress-value");
const sttProgressCard = requiredElement<HTMLElement>("#stt-progress-card");
const sttProgress = requiredElement<HTMLProgressElement>("#stt-progress");
const sttProgressValue = requiredElement<HTMLOutputElement>("#stt-progress-value");

let isListening = false;
let pendingScreenshot: ClipboardWorkflow | undefined;
let pendingScreenshotPermission: ScreenshotPermissionWorkflow | undefined;
let newestLogEntry: LogEntry | undefined;
let pointerIsDown = false;
let earconContext: AudioContext | undefined;
const progressHideTimers: Partial<Record<"nano" | "stt", number>> = {};

function setStatus(
  state: "booting" | "ready" | "listening" | "error",
  label: string,
): void {
  statusChip.dataset.state = state;
  statusLabel.textContent = label;
}

function setListening(listening: boolean): void {
  isListening = listening;
  listenButton.setAttribute("aria-pressed", String(listening));
  listenLabel.textContent = listening ? "Listening…" : "Hold to talk";
  listeningMark.textContent = listening ? "LIVE" : "IDLE";
  listeningMark.dataset.active = String(listening);
  setStatus(listening ? "listening" : "ready", listening ? "Listening" : "On device");
}

function showTranscript(text: string): void {
  transcript.textContent = text || "Your words will appear here.";
  transcript.dataset.placeholder = String(!text);
}

function showNanoState(availability: NanoAvailability): void {
  if (availability === "unavailable") {
    onboarding.hidden = false;
    onboardingTitle.textContent = "Nano is unavailable here.";
    onboardingCopy.textContent =
      "Sotto will not send commands to a server. Check the local hardware requirements below, Chrome policy, and available storage.";
    prepareNano.hidden = true;
    setStatus("error", "Nano unavailable");
    return;
  }

  if (availability === "downloadable" || availability === "downloading") {
    onboarding.hidden = false;
    onboardingTitle.textContent = "One local model to prepare.";
    onboardingCopy.textContent =
      "Chrome can download Gemini Nano after a click. It stays on this device and is shared with Chrome’s built-in AI features.";
    prepareNano.hidden = false;
    prepareNano.textContent =
      availability === "downloading" ? "Continue model setup" : "Prepare Gemini Nano";
    setStatus("booting", availability === "downloading" ? "Nano downloading" : "Nano setup");
    return;
  }

  onboarding.hidden = true;
  prepareNano.hidden = true;
  setStatus(isListening ? "listening" : "ready", isListening ? "Listening" : "On device");
}

function showMicrophoneState(state: PermissionState | "unknown"): void {
  const granted = state === "granted";
  listenButton.disabled = !granted;
  grantMic.textContent =
    state === "denied"
      ? "Review microphone settings"
      : "Grant microphone access";
  if (granted) return;

  listenLabel.textContent = "Use text command";
  setStatus(
    state === "denied" ? "error" : "booting",
    state === "denied" ? "Microphone blocked" : "Microphone setup",
  );
}

async function playEarcon(kind: "listen" | "complete"): Promise<void> {
  try {
    earconContext ??= new AudioContext();
    if (earconContext.state === "suspended") await earconContext.resume();

    const now = earconContext.currentTime;
    const oscillator = earconContext.createOscillator();
    const gain = earconContext.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(kind === "listen" ? 660 : 880, now);
    if (kind === "complete") {
      oscillator.frequency.exponentialRampToValueAtTime(1_140, now + 0.07);
    }
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.09, now + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.095);
    oscillator.connect(gain).connect(earconContext.destination);
    oscillator.start(now);
    oscillator.stop(now + 0.105);
  } catch (error) {
    console.warn("Sotto earcon could not play", error);
  }
}

function updateProgress(
  model: "nano" | "stt",
  value: number,
  complete = value >= 1,
  file?: string,
): void {
  const normalized = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  const card = model === "nano" ? nanoProgressCard : sttProgressCard;
  const bar = model === "nano" ? nanoProgress : sttProgress;
  const output = model === "nano" ? nanoProgressValue : sttProgressValue;
  card.hidden = false;
  if (file) card.title = file;
  bar.value = normalized;
  output.value = `${Math.round(normalized * 100)}%`;
  output.textContent = output.value;
  const previousTimer = progressHideTimers[model];
  if (previousTimer !== undefined) {
    window.clearTimeout(previousTimer);
    delete progressHideTimers[model];
  }
  if (complete) {
    progressHideTimers[model] = window.setTimeout(() => {
      card.hidden = true;
      delete progressHideTimers[model];
    }, 900);
  }
}

function updateLogTime(time: HTMLTimeElement, now: Date): void {
  time.dateTime = now.toISOString();
  time.textContent = now.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function appendLog(heard: string, did: string): void {
  const decision = nextLogEntry(newestLogEntry, heard, did);
  const now = new Date();
  if (decision.collapsed) {
    const newest = actionLog.firstElementChild;
    const time = newest?.querySelector<HTMLTimeElement>("time");
    const count = newest?.querySelector<HTMLElement>(".log-count");
    if (time && count) {
      updateLogTime(time, now);
      count.hidden = false;
      count.textContent = `×${decision.entry.count}`;
      newestLogEntry = decision.entry;
      return;
    }
  }

  actionLog.querySelector(".empty-log")?.remove();
  const item = document.createElement("li");
  const time = document.createElement("time");
  const copy = document.createElement("p");
  const heardText = document.createElement("strong");
  const count = document.createElement("span");
  updateLogTime(time, now);
  heardText.textContent = heard;
  count.className = "log-count";
  count.hidden = true;
  copy.append(
    heardText,
    document.createTextNode(` → ${did}`),
    count,
  );
  item.append(time, copy);
  actionLog.prepend(item);
  newestLogEntry = decision.entry;
}

async function requestWorker<T>(
  message: Record<string, unknown>,
): Promise<T | undefined> {
  const response = (await chrome.runtime.sendMessage({
    target: "worker",
    ...message,
  })) as
    | {
        readonly ok: boolean;
        readonly value?: T;
        readonly error?: { readonly message?: string };
      }
    | undefined;
  if (response?.ok === false) {
    throw new Error(response.error?.message ?? "Extension request failed");
  }
  return response?.value;
}

async function send(message: Record<string, unknown>): Promise<boolean> {
  try {
    await requestWorker(message);
    return true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Extension worker unavailable";
    setStatus("error", "Needs attention");
    appendLog("system", detail);
    return false;
  }
}

async function startListening(): Promise<void> {
  if (isListening) return;
  setListening(true);
  if (!(await send({ type: "start-listening" }))) {
    setListening(false);
    setStatus("error", "Needs attention");
  }
}

async function stopListening(): Promise<void> {
  if (!isListening) return;
  setListening(false);
  if (!(await send({ type: "stop-listening" }))) {
    setListening(true);
    setStatus("error", "Needs attention");
  }
}

listenButton.addEventListener("pointerdown", (event) => {
  pointerIsDown = true;
  listenButton.setPointerCapture(event.pointerId);
  void startListening();
});

listenButton.addEventListener("pointerup", (event) => {
  pointerIsDown = false;
  listenButton.releasePointerCapture(event.pointerId);
  void stopListening();
});

listenButton.addEventListener("pointercancel", () => {
  pointerIsDown = false;
  void stopListening();
});

listenButton.addEventListener("keydown", (event) => {
  if ((event.key === " " || event.key === "Enter") && !event.repeat && !pointerIsDown) {
    event.preventDefault();
    void startListening();
  }
});

listenButton.addEventListener("keyup", (event) => {
  if (event.key === " " || event.key === "Enter") {
    event.preventDefault();
    void stopListening();
  }
});

grantMic.addEventListener("click", () => {
  void send({ type: "open-microphone-page" });
});

commandForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = commandInput.value.trim();
  if (!text) return;
  showTranscript(text);
  commandInput.value = "";
  void send({ type: "text-command", text });
});

clearLog.addEventListener("click", () => {
  actionLog.replaceChildren();
  newestLogEntry = undefined;
  const empty = document.createElement("li");
  empty.className = "empty-log";
  empty.textContent = "No commands yet.";
  actionLog.append(empty);
});

prepareNano.addEventListener("click", async () => {
  prepareNano.disabled = true;
  nanoProgressCard.hidden = false;
  setStatus("booting", "Preparing Nano");

  try {
    if (!("LanguageModel" in globalThis)) {
      throw new Error("Chrome Prompt API is absent");
    }

    const session = await LanguageModel.create({
      initialPrompts: [
        {
          role: "system",
          content: "Initialize the local model for Sotto. Reply briefly.",
        },
      ],
      monitor(monitor) {
        monitor.addEventListener("downloadprogress", (event) => {
          updateProgress("nano", event.loaded);
        });
      },
    });
    session.destroy();
    updateProgress("nano", 1);
    showNanoState("available");
    await send({ type: "nano-ready" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Nano setup failed";
    setStatus("error", "Nano setup failed");
    appendLog("model setup", message);
    prepareNano.disabled = false;
  }
});

function showClipboardWorkflow(workflow: ClipboardWorkflow): void {
  pendingScreenshot = workflow;
  copyScreenshot.textContent = workflow.buttonLabel;
  clipboardCopy.textContent = workflow.afterWrite?.followUp
    ? "Copy the PNG, then Sotto will move you to Claude."
    : "Copy the PNG to your clipboard.";
  clipboardCard.hidden = false;
}

async function completeClipboardWorkflow(
  workflow: ClipboardWorkflow,
): Promise<void> {
  const completion = await performClipboardWorkflow(workflow);
  if (await send({ type: "clipboard-complete", completion })) {
    pendingScreenshot = undefined;
    pendingScreenshotPermission = undefined;
    clipboardCard.hidden = true;
  }
}

copyScreenshot.addEventListener("click", async () => {
  const permissionWorkflow = pendingScreenshotPermission;
  const clipboardWorkflow = pendingScreenshot;
  if (!permissionWorkflow && !clipboardWorkflow) return;
  copyScreenshot.disabled = true;

  try {
    if (permissionWorkflow) {
      const granted = await chrome.permissions
        .request({
          origins: [permissionWorkflow.originPattern],
        })
        .catch((error: unknown) => {
          console.warn("Sotto screenshot permission request failed", error);
          return false;
        });
      if (!granted) {
        const spoken = "Screenshot needs permission for this site.";
        appendLog("screenshot", spoken);
        await send({ type: "speak", text: spoken });
        return;
      }

      const result = await requestWorker<ActionResult>({
        type: "retry-screenshot",
        command: permissionWorkflow.pendingCommand,
      });
      if (result?.workflow?.kind !== "clipboard-write") {
        throw new Error("Screenshot was not ready to copy");
      }
      pendingScreenshotPermission = undefined;
      showClipboardWorkflow(result.workflow);
      await completeClipboardWorkflow(result.workflow);
      return;
    }

    await completeClipboardWorkflow(clipboardWorkflow!);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Clipboard write failed";
    appendLog("copy screenshot", message);
  } finally {
    copyScreenshot.disabled = false;
  }
});

chrome.runtime.onMessage.addListener((raw: unknown) => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return;
  const message = raw as PanelMessage;
  if (message.target !== "sidepanel") return;

  switch (message.type) {
    case "engine-status":
      setListening(message.listening);
      showNanoState(message.nano);
      showMicrophoneState(message.mic);
      if (message.error) appendLog("system", message.error);
      break;
    case "listening-state":
      setListening(message.listening);
      break;
    case "speech-start":
      listeningMark.textContent = "SPEECH";
      listeningMark.dataset.active = "true";
      break;
    case "transcript":
      showTranscript(message.text);
      break;
    case "model-progress":
      updateProgress(
        message.model,
        message.progress,
        message.model === "stt"
          ? message.status === "ready"
          : message.progress >= 1,
        message.file,
      );
      break;
    case "earcon":
      void playEarcon(message.kind);
      break;
    case "action-log":
      appendLog(message.heard, message.did);
      break;
    case "screenshot-ready":
      pendingScreenshotPermission = undefined;
      showClipboardWorkflow(message.workflow);
      break;
    case "screenshot-permission-needed":
      pendingScreenshot = undefined;
      pendingScreenshotPermission = message.workflow;
      copyScreenshot.textContent =
        `Allow capturing ${message.workflow.host} and copy`;
      clipboardCopy.textContent =
        `Sotto needs one-time access to capture ${message.workflow.host}.`;
      clipboardCard.hidden = false;
      break;
    case "pipeline-error":
      setStatus("error", "Needs attention");
      appendLog("system", message.message);
      break;
  }
});

async function showAssignedShortcut(): Promise<void> {
  try {
    const commands = await chrome.commands.getAll();
    const shortcut =
      commands.find((command) => command.name === "toggle-sotto")?.shortcut ?? "";
    shortcutLabel.textContent = shortcut || "UNASSIGNED";
    if (!shortcut) {
      appendLog(
        "shortcut",
        "Assign Toggle Sotto at chrome://extensions/shortcuts",
      );
    }
  } catch (error) {
    console.warn("Sotto could not read its assigned shortcut", error);
  }
}

showTranscript("");
void send({ type: "get-status" });
void showAssignedShortcut();
