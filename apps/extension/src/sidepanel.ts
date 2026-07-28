import type { ClipboardWorkflow } from "@sotto/core";
import { performClipboardWorkflow } from "@sotto/destinations";
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
      file?: string;
    }
  | { target: "sidepanel"; type: "action-log"; heard: string; did: string }
  | {
      target: "sidepanel";
      type: "screenshot-ready";
      workflow: ClipboardWorkflow;
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
const grantMic = requiredElement<HTMLButtonElement>("#grant-mic");
const commandForm = requiredElement<HTMLFormElement>("#command-form");
const commandInput = requiredElement<HTMLInputElement>("#command-input");
const clipboardCard = requiredElement<HTMLElement>("#clipboard-card");
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
let pointerIsDown = false;

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

function updateProgress(model: "nano" | "stt", value: number): void {
  const normalized = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  const card = model === "nano" ? nanoProgressCard : sttProgressCard;
  const bar = model === "nano" ? nanoProgress : sttProgress;
  const output = model === "nano" ? nanoProgressValue : sttProgressValue;
  card.hidden = false;
  bar.value = normalized;
  output.value = `${Math.round(normalized * 100)}%`;
  output.textContent = output.value;
  if (normalized >= 1) {
    window.setTimeout(() => {
      card.hidden = true;
    }, 900);
  }
}

function appendLog(heard: string, did: string): void {
  actionLog.querySelector(".empty-log")?.remove();
  const item = document.createElement("li");
  const time = document.createElement("time");
  const copy = document.createElement("p");
  const heardText = document.createElement("strong");
  time.dateTime = new Date().toISOString();
  time.textContent = new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  heardText.textContent = heard;
  copy.append(heardText, document.createTextNode(` → ${did}`));
  item.append(time, copy);
  actionLog.prepend(item);
}

async function send(message: Record<string, unknown>): Promise<void> {
  try {
    const response = (await chrome.runtime.sendMessage({
      target: "worker",
      ...message,
    })) as
      | {
          readonly ok: boolean;
          readonly error?: { readonly message?: string };
        }
      | undefined;
    if (response?.ok === false) {
      throw new Error(response.error?.message ?? "Extension request failed");
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Extension worker unavailable";
    setStatus("error", "Needs attention");
    appendLog("system", detail);
  }
}

async function startListening(): Promise<void> {
  if (isListening) return;
  setListening(true);
  await send({ type: "start-listening" });
}

async function stopListening(): Promise<void> {
  if (!isListening) return;
  setListening(false);
  await send({ type: "stop-listening" });
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

copyScreenshot.addEventListener("click", async () => {
  if (!pendingScreenshot) return;
  copyScreenshot.disabled = true;

  try {
    const completion = await performClipboardWorkflow(pendingScreenshot);
    pendingScreenshot = undefined;
    clipboardCard.hidden = true;
    await send({ type: "clipboard-complete", completion });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Clipboard write failed";
    appendLog("copy screenshot", message);
  } finally {
    copyScreenshot.disabled = false;
  }
});

chrome.runtime.onMessage.addListener((message: PanelMessage) => {
  if (message.target !== "sidepanel") return;

  switch (message.type) {
    case "engine-status":
      setListening(message.listening);
      showNanoState(message.nano);
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
      updateProgress(message.model, message.progress);
      break;
    case "action-log":
      appendLog(message.heard, message.did);
      break;
    case "screenshot-ready":
      pendingScreenshot = message.workflow;
      copyScreenshot.textContent = message.workflow.buttonLabel;
      clipboardCard.hidden = false;
      break;
    case "pipeline-error":
      setStatus("error", "Needs attention");
      appendLog("system", message.message);
      break;
  }
});

showTranscript("");
void send({ type: "get-status" });
