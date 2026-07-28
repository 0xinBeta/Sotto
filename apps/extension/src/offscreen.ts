import { MicVAD } from "@ricky0123/vad-web";
import actions from "@sotto/actions";
import {
  ActionRegistry,
  type ActionCommand,
  type ActionResult,
} from "@sotto/core";
import {
  createParserSession,
  createResponderSession,
  getNanoAvailability,
  parseCommand,
  respondOneSentence,
  type NanoAvailability,
  type NanoSession,
} from "@sotto/nano";
import {
  MoonshineEngine,
  type SttProgress,
} from "@sotto/stt";
import { performOffscreenClipboardWorkflow } from "./offscreen-clipboard.js";

interface OffscreenMessage {
  readonly target: "offscreen";
  readonly type: string;
  readonly transcript?: unknown;
  readonly command?: unknown;
  readonly result?: unknown;
  readonly spoken?: unknown;
  readonly detail?: unknown;
}

interface MessageEnvelope<T> {
  readonly ok: boolean;
  readonly value?: T;
  readonly error?: {
    readonly name: string;
    readonly message: string;
  };
}

const registry = new ActionRegistry(actions);
const stt = new MoonshineEngine();

let vad: MicVAD | undefined;
let micStream: MediaStream | undefined;
let parserSession: NanoSession | undefined;
let responderSession: NanoSession | undefined;
let parserSessionPromise: Promise<NanoSession | undefined> | undefined;
let responderSessionPromise: Promise<NanoSession | undefined> | undefined;
let nanoAvailability: NanoAvailability = "unavailable";
let listening = false;
let starting = false;
let stopRequested = false;
let stopTimer: number | undefined;
let transcriptPipeline = Promise.resolve();
let sttReady: Promise<void> | undefined;

async function sendPanel(message: Record<string, unknown>): Promise<void> {
  try {
    await chrome.runtime.sendMessage({ target: "sidepanel", ...message });
  } catch {
    // A panel is not required for hotkey-only use.
  }
}

async function askWorker<T>(
  message: Record<string, unknown>,
): Promise<T | undefined> {
  const response = (await chrome.runtime.sendMessage({
    target: "worker",
    ...message,
  })) as MessageEnvelope<T> | undefined;
  if (!response) return undefined;
  if (!response.ok) {
    throw new Error(response.error?.message ?? "Service worker request failed");
  }
  return response.value;
}

async function permissionState(): Promise<PermissionState | "unknown"> {
  try {
    const status = await navigator.permissions.query({
      name: "microphone" as PermissionName,
    });
    return status.state;
  } catch {
    return "unknown";
  }
}

async function publishStatus(error?: string): Promise<void> {
  nanoAvailability = await getNanoAvailability();
  await sendPanel({
    type: "engine-status",
    nano: nanoAvailability,
    listening,
    mic: await permissionState(),
    ...(error === undefined ? {} : { error }),
  });
}

function progressRatio(progress: SttProgress): number | undefined {
  if (typeof progress.progress === "number") {
    return progress.progress > 1
      ? progress.progress / 100
      : progress.progress;
  }
  if (
    typeof progress.loaded === "number" &&
    typeof progress.total === "number" &&
    progress.total > 0
  ) {
    return progress.loaded / progress.total;
  }
  if (progress.status === "ready") return 1;
  return undefined;
}

async function ensureParserSession(): Promise<NanoSession | undefined> {
  if (parserSession && !parserSession.destroyed) return parserSession;
  if (parserSessionPromise) return parserSessionPromise;

  parserSessionPromise = (async () => {
    nanoAvailability = await getNanoAvailability();
    if (nanoAvailability !== "available") return undefined;

    const created = await createParserSession({
      registry,
      onDownloadProgress(progress) {
        void sendPanel({
          type: "model-progress",
          model: "nano",
          progress: progress.loaded,
        });
      },
    });
    if (!created.ok) {
      nanoAvailability = created.availability;
      if (created.error) {
        console.warn("Gemini Nano parser session creation failed", created.error);
        await sendPanel({
          type: "pipeline-error",
          message: `Gemini Nano could not start: ${created.error.message}`,
        });
      }
      return undefined;
    }
    parserSession = created.session;
    return parserSession;
  })();

  try {
    return await parserSessionPromise;
  } finally {
    parserSessionPromise = undefined;
  }
}

async function ensureResponderSession(): Promise<NanoSession | undefined> {
  if (responderSession && !responderSession.destroyed) return responderSession;
  if (responderSessionPromise) return responderSessionPromise;

  responderSessionPromise = (async () => {
    if ((await getNanoAvailability()) !== "available") return undefined;
    const created = await createResponderSession();
    if (!created.ok) return undefined;
    responderSession = created.session;
    return responderSession;
  })();

  try {
    return await responderSessionPromise;
  } finally {
    responderSessionPromise = undefined;
  }
}

function cleanTranscript(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 2_000);
}

async function processTranscript(rawTranscript: string): Promise<void> {
  const transcript = cleanTranscript(rawTranscript);
  if (!transcript) return;

  await sendPanel({ type: "transcript", text: transcript });
  const session = await ensureParserSession();
  const command = await parseCommand({
    session,
    registry,
    transcript,
    onError(error) {
      console.warn("Nano intent parsing failed closed", error);
      void sendPanel({
        type: "pipeline-error",
        message: `Gemini Nano could not parse that command: ${error.message}`,
      });
    },
  });
  await askWorker({
    type: "execute-command",
    transcript,
    command,
  });
}

async function processSpeech(audio: Float32Array): Promise<void> {
  try {
    await ensureStt();
    const text = await stt.transcribe(audio);
    if (!text) {
      await sendPanel({
        type: "pipeline-error",
        message: "No speech was recognized. Try again or type the command.",
      });
      await speak("Sorry, say that again?");
      return;
    }
    await processTranscript(text);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Speech transcription failed";
    console.warn("Sotto speech transcription failed", error);
    await sendPanel({ type: "pipeline-error", message });
    await speak("I couldn't transcribe that. Try again or type the command.");
  }
}

function ensureStt(): Promise<void> {
  if (!sttReady) {
    const pending = stt.init((progress) => {
      const ratio = progressRatio(progress);
      if (ratio === undefined) return;
      void sendPanel({
        type: "model-progress",
        model: "stt",
        progress: Math.max(0, Math.min(1, ratio)),
        status: progress.status,
        ...(progress.file === undefined ? {} : { file: progress.file }),
      });
    });
    sttReady = pending.catch((error: unknown) => {
      sttReady = undefined;
      throw error;
    });
  }
  return sttReady;
}

async function openMicrophone(): Promise<MediaStream> {
  const permission = await permissionState();
  if (permission !== "granted") {
    throw new DOMException(
      "Grant microphone access in the full extension tab first",
      "NotAllowedError",
    );
  }

  micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: false,
  });
  return micStream;
}

async function startListening(): Promise<void> {
  if (starting) {
    stopRequested = false;
    return;
  }
  if (stopTimer !== undefined) {
    window.clearTimeout(stopTimer);
    stopTimer = undefined;
  }
  if (listening) {
    await sendPanel({ type: "listening-state", listening: true });
    return;
  }
  starting = true;
  stopRequested = false;

  try {
    const stream = await openMicrophone();
    void ensureStt().catch(async (error: unknown) => {
      const message =
        error instanceof Error ? error.message : "Speech model setup failed";
      await sendPanel({ type: "pipeline-error", message });
    });

    vad = await MicVAD.new({
      model: "v5",
      baseAssetPath: chrome.runtime.getURL("assets/vad/"),
      onnxWASMBasePath: chrome.runtime.getURL("assets/ort-vad/"),
      startOnLoad: false,
      submitUserSpeechOnPause: true,
      getStream: async () => stream,
      ortConfig(ort) {
        ort.env.wasm.numThreads = 1;
      },
      onSpeechStart() {
        void sendPanel({ type: "speech-start" });
      },
      onVADMisfire() {
        // Intentionally ignore too-short speech so silence is never sent to STT.
      },
      onSpeechEnd(audio) {
        transcriptPipeline = transcriptPipeline
          .then(() => processSpeech(audio))
          .catch((error: unknown) => {
            console.warn("Speech pipeline failed", error);
          });
      },
    });
    await vad.start();
    listening = true;
    starting = false;
    await sendPanel({ type: "earcon", kind: "listen" });
    await sendPanel({ type: "listening-state", listening: true });
    if (stopRequested) await stopListeningNow();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Microphone failed";
    listening = false;
    micStream?.getTracks().forEach((track) => track.stop());
    micStream = undefined;
    await publishStatus(message);
    throw error;
  } finally {
    starting = false;
  }
}

async function stopListeningNow(): Promise<void> {
  stopTimer = undefined;
  const activeVad = vad;
  vad = undefined;
  listening = false;

  try {
    await activeVad?.destroy();
  } finally {
    micStream?.getTracks().forEach((track) => track.stop());
    micStream = undefined;
    await sendPanel({ type: "listening-state", listening: false });
  }
}

function stopListening(): void {
  if (starting) {
    stopRequested = true;
    return;
  }
  if (!listening || stopTimer !== undefined) return;
  // Let VAD observe a short tail after push-to-talk release and emit speech.
  stopTimer = window.setTimeout(() => {
    void stopListeningNow().catch(async (error: unknown) => {
      const message =
        error instanceof Error ? error.message : "Microphone cleanup failed";
      console.warn("Sotto could not stop listening cleanly", error);
      await sendPanel({ type: "pipeline-error", message });
    });
  }, 650);
}

async function speak(text: string): Promise<void> {
  await askWorker({ type: "speak", text });
}

function isActionCommand(value: unknown): value is ActionCommand {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { action?: unknown }).action === "string"
  );
}

function isActionResult(value: unknown): value is ActionResult {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { spoken?: unknown }).spoken === "string"
  );
}

async function handleActionResult(message: OffscreenMessage): Promise<unknown> {
  if (
    !isActionCommand(message.command) ||
    !isActionResult(message.result)
  ) {
    throw new TypeError("Worker returned an invalid action result");
  }

  const transcript =
    typeof message.transcript === "string" ? message.transcript : "command";
  const command = message.command;
  const result = message.result;
  if (result.workflow?.kind === "clipboard-write") {
    try {
      return await performOffscreenClipboardWorkflow(result.workflow);
    } catch (error) {
      console.warn("Sotto automatic screenshot copy failed", error);
      await sendPanel({
        type: "screenshot-ready",
        workflow: result.workflow,
      });
    }
  }
  if (!result.workflow) {
    await sendPanel({ type: "earcon", kind: "complete" });
  }
  await sendPanel({
    type: "action-log",
    heard: transcript,
    did: result.spoken,
  });

  const spoken =
    command.action === "unknown"
      ? "Sorry, say that again?"
      : await respondOneSentence({
          session: await ensureResponderSession(),
          command,
          result,
          onError(error) {
            console.warn("Nano responder used deterministic fallback", error);
          },
        });
  await speak(spoken);
  return undefined;
}

async function resetNanoSessions(): Promise<void> {
  parserSession?.destroy();
  responderSession?.destroy();
  parserSession = undefined;
  responderSession = undefined;
  nanoAvailability = await getNanoAvailability();
  if (nanoAvailability === "available") {
    await ensureParserSession();
  }
  await publishStatus();
}

async function handleOffscreenMessage(
  message: OffscreenMessage,
): Promise<unknown> {
  switch (message.type) {
    case "get-status":
    case "refresh-permissions":
      await publishStatus();
      return;
    case "nano-ready":
      await resetNanoSessions();
      return;
    case "start-listening":
      await startListening();
      return;
    case "stop-listening":
      stopListening();
      return;
    case "toggle-listening":
      if (listening || starting) stopListening();
      else await startListening();
      return;
    case "parse-transcript":
      if (typeof message.transcript !== "string") {
        throw new TypeError("A transcript string is required");
      }
      await processTranscript(message.transcript);
      return;
    case "action-result":
      return handleActionResult(message);
    case "action-error": {
      const transcript =
        typeof message.transcript === "string" ? message.transcript : "command";
      const spoken =
        typeof message.spoken === "string"
          ? message.spoken
          : "That action could not be completed.";
      await sendPanel({
        type: "action-log",
        heard: transcript,
        did:
          typeof message.detail === "string"
            ? message.detail
            : "action failed",
      });
      await speak(spoken);
      return;
    }
    case "workflow-complete":
      await sendPanel({ type: "earcon", kind: "complete" });
      await speak(
        typeof message.spoken === "string"
          ? message.spoken
          : "Screenshot copied.",
      );
      return;
    default:
      throw new TypeError(`Unsupported offscreen message type: ${message.type}`);
  }
}

chrome.runtime.onMessage.addListener(
  (raw: unknown, _sender, sendResponse): boolean | void => {
    if (
      typeof raw !== "object" ||
      raw === null ||
      Array.isArray(raw) ||
      (raw as { target?: unknown }).target !== "offscreen"
    ) {
      return;
    }

    void handleOffscreenMessage(raw as OffscreenMessage)
      .then((value) =>
        sendResponse(value === undefined ? { ok: true } : { ok: true, value }),
      )
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        sendResponse({ ok: false, error: { name: "Error", message } });
      });
    return true;
  },
);

window.addEventListener("unload", () => {
  micStream?.getTracks().forEach((track) => track.stop());
  parserSession?.destroy();
  responderSession?.destroy();
  void stt.dispose().catch((error: unknown) => {
    console.warn("Moonshine cleanup failed", error);
  });
});
