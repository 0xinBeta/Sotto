import { MicVAD } from "@ricky0123/vad-web";
import type { ActionCommand, ActionResult } from "@sotto/core";
import { DefaultLocalInferenceHost } from "./local-inference-host.js";
import { computeRms, smoothMicLevel } from "./mic-level.js";
import {
  SpeechContextRing,
  type SpeechRetryAudio,
  type SttDiagnostic,
} from "./stt-guards.js";
import {
  isExchangeTimings,
  type ExchangeTimings,
} from "./timings.js";

interface OffscreenMessage {
  readonly target: "offscreen";
  readonly type: string;
  readonly transcript?: unknown;
  readonly command?: unknown;
  readonly result?: unknown;
  readonly spoken?: unknown;
  readonly detail?: unknown;
  readonly task?: unknown;
  readonly sourceText?: unknown;
  readonly transformation?: unknown;
  readonly text?: unknown;
  readonly utteranceId?: unknown;
  readonly enabled?: unknown;
  readonly rate?: unknown;
  readonly volume?: unknown;
  readonly timings?: unknown;
}

interface MessageEnvelope<T> {
  readonly ok: boolean;
  readonly value?: T;
  readonly error?: {
    readonly name: string;
    readonly message: string;
  };
}

const speechContext = new SpeechContextRing();
const parseDurations = new Map<ActionCommand, number>();

let vad: MicVAD | undefined;
let micStream: MediaStream | undefined;
let listening = false;
let starting = false;
let stopRequested = false;
let stopTimer: number | undefined;
let micLevelContext: AudioContext | undefined;
let micLevelSource: MediaStreamAudioSourceNode | undefined;
let micLevelAnalyser: AnalyserNode | undefined;
let micLevelTimer: number | undefined;
let micLevel = 0;
let micLevelPeak = 0;
let transcriptPipeline = Promise.resolve();
let activeModelTask: AbortController | undefined;

function cancelActiveModelTask(): void {
  activeModelTask?.abort();
  activeModelTask = undefined;
}

async function withModelTask<T>(
  task: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  cancelActiveModelTask();
  const controller = new AbortController();
  activeModelTask = controller;
  try {
    return await task(controller.signal);
  } finally {
    if (activeModelTask === controller) activeModelTask = undefined;
  }
}

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

const inferenceHost = new DefaultLocalInferenceHost({
  sendPanel,
  askWorker,
  onSttDiagnostic: (diagnostic) => {
    void publishSttDiagnostic(diagnostic);
  },
  scheduleSttTimeoutRecovery,
  onParseDuration: (command, durationMs) => {
    parseDurations.set(command, durationMs);
  },
});

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
  const snapshot = await inferenceHost.manage({ type: "status" });
  await sendPanel({
    type: "engine-status",
    nano: snapshot.nano,
    listening,
    mic: await permissionState(),
    ...(error === undefined ? {} : { error }),
  });
  await inferenceHost.manage({ type: "publish-premium-tts-status" });
  await inferenceHost.manage({ type: "publish-premium-stt-status" });
}

const STT_DIAGNOSTIC_MESSAGES: Record<SttDiagnostic, string> = {
  "vad-rejected":
    "Speech was too short or quiet. Keep holding the key through the full command.",
  "blank-result":
    "Speech reached the recognizer, but it returned no plausible words.",
  timeout:
    "Speech recognition timed out. Sotto kept the local fallback available.",
  "webgpu-failed":
    "The WebGPU speech engine failed. Sotto is retrying or using Moonshine.",
};

function sttDiagnosticMessage(
  diagnostic: SttDiagnostic,
  observedMicLevel?: number,
): string {
  if (
    (diagnostic === "vad-rejected" || diagnostic === "blank-result") &&
    observedMicLevel !== undefined
  ) {
    return observedMicLevel < 0.035
      ? "The microphone level was very low."
      : "The meter showed sound, but Sotto found no clear words.";
  }
  return STT_DIAGNOSTIC_MESSAGES[diagnostic];
}

async function publishSttDiagnostic(
  diagnostic: SttDiagnostic,
  observedMicLevel?: number,
): Promise<void> {
  await sendPanel({
    type: "stt-diagnostic",
    diagnostic,
    message: sttDiagnosticMessage(diagnostic, observedMicLevel),
  });
}

let sttTimeoutRecoveryScheduled = false;

function scheduleSttTimeoutRecovery(): void {
  if (
    sttTimeoutRecoveryScheduled ||
    typeof window.location?.reload !== "function"
  ) {
    return;
  }
  sttTimeoutRecoveryScheduled = true;
  setTimeout(() => {
    window.location.reload();
  }, 0);
}

function cleanTranscript(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 2_000);
}

async function processTranscript(
  rawTranscript: string,
  timings: ExchangeTimings,
): Promise<void> {
  const transcript = cleanTranscript(rawTranscript);
  if (!transcript) return;

  await sendPanel({ type: "transcript", text: transcript });
  const command = await inferenceHost.parseTranscript(transcript);
  const parseMs = parseDurations.get(command) ?? 0;
  parseDurations.delete(command);
  await askWorker({
    type: "execute-command",
    transcript,
    command,
    timings: { ...timings, parseMs },
  });
}

async function processSpeech(
  input: SpeechRetryAudio,
  observedMicLevel: number,
  sttStartedAt: number,
): Promise<void> {
  try {
    const result = await inferenceHost.transcribe(input);
    if (!result.ok) {
      await publishSttDiagnostic(result.diagnostic, observedMicLevel);
      if (result.diagnostic === "blank-result") {
        await speak("I heard speech but couldn't make out the words.");
      } else if (result.diagnostic === "timeout") {
        await speak("Speech recognition timed out. Try again.");
        scheduleSttTimeoutRecovery();
      } else if (result.diagnostic === "webgpu-failed") {
        await speak("The speech engine failed. Sotto kept the fallback ready.");
      }
      return;
    }
    await processTranscript(result.text, {
      input: "voice",
      sttMs: Math.max(0, performance.now() - sttStartedAt),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Speech transcription failed";
    console.warn("Sotto speech transcription failed", error);
    await sendPanel({ type: "pipeline-error", message });
    await speak("I couldn't transcribe that. Try again or type the command.");
  }
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

const MIC_LEVEL_SAMPLE_INTERVAL_MS = Math.round(1_000 / 15);

function stopMicLevelMeter(): void {
  if (micLevelTimer !== undefined) {
    window.clearInterval(micLevelTimer);
    micLevelTimer = undefined;
  }
  micLevelSource?.disconnect();
  micLevelAnalyser?.disconnect();
  micLevelSource = undefined;
  micLevelAnalyser = undefined;
  const context = micLevelContext;
  micLevelContext = undefined;
  void context?.close().catch(() => undefined);
}

function startMicLevelMeter(stream: MediaStream): void {
  stopMicLevelMeter();
  micLevel = 0;
  micLevelPeak = 0;
  if (typeof AudioContext === "undefined") return;

  try {
    const context = new AudioContext();
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0;
    source.connect(analyser);

    const samples = new Float32Array(analyser.fftSize);
    micLevelContext = context;
    micLevelSource = source;
    micLevelAnalyser = analyser;
    void context.resume().catch(() => undefined);
    micLevelTimer = window.setInterval(() => {
      if (!listening || micLevelAnalyser !== analyser) return;
      analyser.getFloatTimeDomainData(samples);
      micLevel = smoothMicLevel(micLevel, computeRms(samples));
      micLevelPeak = Math.max(micLevelPeak, micLevel);
      void sendPanel({ type: "mic-level", level: micLevel });
    }, MIC_LEVEL_SAMPLE_INTERVAL_MS);
  } catch (error) {
    console.warn("Sotto could not start the microphone meter", error);
    stopMicLevelMeter();
  }
}

async function startListening(): Promise<void> {
  void inferenceHost.handleSpeech({ type: "stop" });
  if (starting) {
    stopRequested = false;
    return;
  }
  if (stopTimer !== undefined) {
    window.clearTimeout(stopTimer);
    stopTimer = undefined;
  }
  if (listening) {
    if (micStream && micLevelTimer === undefined) {
      startMicLevelMeter(micStream);
    }
    await sendPanel({ type: "listening-state", listening: true });
    return;
  }
  starting = true;
  stopRequested = false;

  try {
    const stream = await openMicrophone();
    void inferenceHost.manage({ type: "ensure-stt" }).catch(
      async (error: unknown) => {
      const message =
        error instanceof Error ? error.message : "Speech model setup failed";
      await sendPanel({ type: "pipeline-error", message });
      },
    );

    vad = await MicVAD.new({
      model: "v5",
      baseAssetPath: chrome.runtime.getURL("assets/vad/"),
      onnxWASMBasePath: chrome.runtime.getURL("assets/ort-kokoro/"),
      startOnLoad: false,
      submitUserSpeechOnPause: true,
      positiveSpeechThreshold: 0.3,
      negativeSpeechThreshold: 0.25,
      preSpeechPadMs: 256,
      redemptionMs: 192,
      minSpeechMs: 320,
      getStream: async () => stream,
      ortConfig(ort) {
        ort.env.wasm.numThreads = 1;
      },
      onSpeechStart() {
        speechContext.onSpeechStart();
        void sendPanel({ type: "speech-start" });
      },
      onVADMisfire() {
        speechContext.onVADMisfire();
        void sendPanel({ type: "speech-end" });
        void publishSttDiagnostic("vad-rejected", micLevelPeak);
      },
      onFrameProcessed(_probabilities, frame) {
        speechContext.onFrame(frame);
      },
      onSpeechEnd(audio) {
        const sttStartedAt = performance.now();
        const input = speechContext.onSpeechEnd(audio);
        const observedMicLevel = micLevelPeak;
        void sendPanel({ type: "speech-end" });
        transcriptPipeline = transcriptPipeline
          .then(() => processSpeech(input, observedMicLevel, sttStartedAt))
          .catch((error: unknown) => {
            console.warn("Speech pipeline failed", error);
          });
      },
    });
    await vad.start();
    listening = true;
    starting = false;
    if (!stopRequested) startMicLevelMeter(stream);
    await sendPanel({ type: "earcon", kind: "listen" });
    await sendPanel({ type: "listening-state", listening: true });
    if (stopRequested) await stopListeningNow();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Microphone failed";
    listening = false;
    stopMicLevelMeter();
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
  stopMicLevelMeter();

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
  stopMicLevelMeter();
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

async function speak(
  text: string,
  log?: {
    readonly heard: string;
    readonly did: string;
    readonly timings: ExchangeTimings;
  },
): Promise<void> {
  await askWorker({
    type: "speak",
    text,
    ...(log === undefined ? {} : log),
  });
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
    await sendPanel({
      type: "screenshot-ready",
      workflow: result.workflow,
    });
  }
  if (!result.workflow) {
    await sendPanel({ type: "earcon", kind: "complete" });
  }

  const spoken = command.action === "unknown"
    ? "Sorry, say that again?"
    : await inferenceHost.generate(
        { type: "respond", command, result },
        new AbortController().signal,
      );
  await speak(spoken, {
    heard: transcript,
    did: result.spoken,
    timings: isExchangeTimings(message.timings)
      ? message.timings
      : { input: "voice" },
  });
  return undefined;
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
      await inferenceHost.manage({ type: "nano-ready" });
      await publishStatus();
      return;
    case "prepare-premium-tts":
      await inferenceHost.manage({ type: "prepare-premium-tts" });
      return;
    case "set-premium-tts-enabled":
      await inferenceHost.manage({
        type: "set-premium-tts-enabled",
        enabled: message.enabled,
      });
      return;
    case "prepare-premium-stt":
      await inferenceHost.manage({ type: "prepare-premium-stt" });
      return;
    case "set-premium-stt-enabled":
      await inferenceHost.manage({
        type: "set-premium-stt-enabled",
        enabled: message.enabled,
      });
      return;
    case "premium-speak":
      await inferenceHost.handleSpeech({
        type: "speak",
        text: message.text,
        utteranceId: message.utteranceId,
        rate: message.rate,
        volume: message.volume,
      });
      return;
    case "premium-stop":
      await inferenceHost.handleSpeech({
        type: "stop",
        utteranceId: message.utteranceId,
      });
      return;
    case "premium-probe":
      await inferenceHost.handleSpeech({ type: "probe" });
      return;
    case "start-listening":
      cancelActiveModelTask();
      await startListening();
      return;
    case "stop-listening":
      stopListening();
      return;
    case "toggle-listening":
      cancelActiveModelTask();
      if (listening || starting) stopListening();
      else await startListening();
      return;
    case "parse-transcript":
      cancelActiveModelTask();
      if (typeof message.transcript !== "string") {
        throw new TypeError("A transcript string is required");
      }
      await processTranscript(
        message.transcript,
        isExchangeTimings(message.timings)
          ? message.timings
          : { input: "typed" },
      );
      return;
    case "page-task":
      return withModelTask((signal) =>
        inferenceHost.generate(
          { type: "page", task: message.task },
          signal,
        )
      );
    case "rewrite-task":
      return withModelTask((signal) =>
        inferenceHost.generate(
          {
            type: "rewrite",
            sourceText: message.sourceText,
            transformation: message.transformation,
          },
          signal,
        )
      );
    case "action-result":
      return handleActionResult(message);
    case "action-error": {
      const transcript =
        typeof message.transcript === "string" ? message.transcript : "command";
      const spoken =
        typeof message.spoken === "string"
          ? message.spoken
          : "That action could not be completed.";
      await speak(spoken, {
        heard: transcript,
        did:
          typeof message.detail === "string"
            ? message.detail
            : "action failed",
        timings: isExchangeTimings(message.timings)
          ? message.timings
          : { input: "voice" },
      });
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
  cancelActiveModelTask();
  stopMicLevelMeter();
  speechContext.dispose();
  micStream?.getTracks().forEach((track) => track.stop());
  void inferenceHost.dispose();
});
