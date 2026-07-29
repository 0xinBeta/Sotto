import { describe, expect, it } from "vitest";

import {
  buildDiagnosticReport,
  PipelineErrorBuffer,
  type DiagnosticModel,
  type DiagnosticPipelineError,
  type DiagnosticReportInput,
} from "../src/diagnostic-report.js";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
    (<Value>() => Value extends Right ? 1 : 2)
    ? true
    : false;

type ReportField =
  | "generatedAt"
  | "extensionVersion"
  | "chromeVersion"
  | "platform"
  | "webGpu"
  | "models"
  | "modelStorageBytes"
  | "sttEngine"
  | "sttTier"
  | "sttBackend"
  | "premiumSttEnabled"
  | "premiumSttState"
  | "ttsEngine"
  | "premiumTtsEnabled"
  | "premiumTtsState"
  | "premiumTtsVoice"
  | "premiumTtsBackend"
  | "nanoAvailability"
  | "summarizerAvailability"
  | "micPermission"
  | "rate"
  | "volume"
  | "storageBytes"
  | "pipelineErrors"
  | "latency";

const reportTypeHasOnlyAllowedFields: Equal<
  keyof DiagnosticReportInput,
  ReportField
> = true;
const modelTypeHasOnlyAllowedFields: Equal<
  keyof DiagnosticModel,
  "id" | "state" | "bytes"
> = true;
const errorTypeHasOnlyAllowedFields: Equal<
  keyof DiagnosticPipelineError,
  "timestamp" | "message"
> = true;

function reportInput(): DiagnosticReportInput {
  return {
    generatedAt: "2026-07-29T10:20:30.000Z",
    extensionVersion: "0.3.1",
    chromeVersion: "140.0.7339.12",
    platform: "macOS 15.5.0",
    webGpu: true,
    models: [
      {
        id: "moonshine-tiny",
        state: "active",
        bytes: 1_536,
      },
      {
        id: "gemini-nano",
        state: "cached",
      },
    ],
    modelStorageBytes: 2_048,
    sttEngine: "parakeet",
    sttTier: "v3",
    sttBackend: "webgpu",
    premiumSttEnabled: true,
    premiumSttState: "active",
    ttsEngine: "kokoro",
    premiumTtsEnabled: true,
    premiumTtsState: "ready",
    premiumTtsVoice: "af_heart",
    premiumTtsBackend: "webgpu",
    nanoAvailability: "available",
    summarizerAvailability: "downloadable",
    micPermission: "granted",
    rate: 1.2,
    volume: 0.8,
    storageBytes: 1_024,
    pipelineErrors: [
      {
        timestamp: "2026-07-29T10:19:00.000Z",
        message: "WebGPU device was lost",
      },
    ],
    latency: {
      sampleCount: 2,
      stt: { sampleCount: 1, p50Ms: 420, p95Ms: 420 },
      parse: { sampleCount: 2, p50Ms: 310, p95Ms: 500 },
      act: { sampleCount: 2, p50Ms: 45, p95Ms: 90 },
      voice: { sampleCount: 1, p50Ms: 1_100, p95Ms: 1_100 },
      total: { sampleCount: 2, p50Ms: 855, p95Ms: 1_690 },
    },
  };
}

describe("diagnostic report", () => {
  it("uses the exact safe input shape", () => {
    expect(reportTypeHasOnlyAllowedFields).toBe(true);
    expect(modelTypeHasOnlyAllowedFields).toBe(true);
    expect(errorTypeHasOnlyAllowedFields).toBe(true);
  });

  it("builds stable plain text with clear sections", () => {
    const report = buildDiagnosticReport(reportInput());

    expect(report).toBe(
      [
        "# Sotto diagnostic report",
        "Generated: 2026-07-29T10:20:30.000Z",
        "Extension version: 0.3.1",
        "",
        "## Runtime",
        "Chrome version: 140.0.7339.12",
        "Platform: macOS 15.5.0",
        "WebGPU: yes",
        "",
        "## Models",
        "- moonshine-tiny: active, 1.50 KiB",
        "- gemini-nano: cached, unknown",
        "Model cache bytes: 2.00 KiB",
        "Extension storage bytes: 1.00 KiB",
        "",
        "## Settings",
        "Speech input engine: parakeet",
        "Speech input tier: v3",
        "Speech input backend: webgpu",
        "Premium speech input: on",
        "Premium speech input state: active",
        "Speech output engine: kokoro",
        "Premium speech output: on",
        "Premium speech output state: ready",
        "Premium voice: af_heart",
        "Premium speech output backend: webgpu",
        "Rate: 1.2",
        "Volume: 80%",
        "",
        "## Chrome AI",
        "Gemini Nano: available",
        "Summarizer: downloadable",
        "",
        "## Permissions",
        "Microphone: granted",
        "",
        "## Latency",
        "Samples: 2",
        "| Stage | p50 | p95 | Samples |",
        "| --- | ---: | ---: | ---: |",
        "| Speech input | 420ms | 420ms | 1 |",
        "| Parse | 310ms | 500ms | 2 |",
        "| Act | 45ms | 90ms | 2 |",
        "| Voice | 1.1s | 1.1s | 1 |",
        "| Total | 855ms | 1.7s | 2 |",
        "",
        "## Pipeline errors",
        "- 2026-07-29T10:19:00.000Z — WebGPU device was lost",
      ].join("\n"),
    );
    expect(report.split("\n").length).toBeLessThanOrEqual(120);
  });

  it("renders missing latency stages in the report", () => {
    const input = reportInput();
    const report = buildDiagnosticReport({
      ...input,
      latency: {
        ...input.latency,
        stt: { sampleCount: 0 },
      },
    });

    expect(report).toContain("## Latency");
    expect(report).toContain("Samples: 2");
    expect(report).toContain("| Speech input | — | — | 0 |");
    expect(report).toContain("| Total | 855ms | 1.7s | 2 |");
  });

  it("does not copy sensitive application state into the report", () => {
    const sensitive = [
      "secret transcript",
      "secret page text",
      "secret page title",
      "https://private.example/account",
      "secret note contents",
      "secret reminder text",
      "secret clipboard data",
      "secret audio bytes",
    ];
    const input = {
      ...reportInput(),
      transcript: sensitive[0],
      pageText: sensitive[1],
      pageTitle: sensitive[2],
      url: sensitive[3],
      noteContents: sensitive[4],
      reminderText: sensitive[5],
      clipboardData: sensitive[6],
      audio: sensitive[7],
      pipelineErrors: [
        {
          timestamp: "2026-07-29T10:19:00.000Z",
          message: `Model request failed at ${sensitive[3]}`,
        },
      ],
    } as unknown as DiagnosticReportInput;

    const report = buildDiagnosticReport(input);

    for (const value of sensitive) {
      expect(report).not.toContain(value);
    }
    expect(report).toContain("Model request failed at [removed URL]");
  });

  it("keeps only the last 10 pipeline errors", () => {
    const errors = new PipelineErrorBuffer();
    for (let index = 1; index <= 12; index += 1) {
      errors.add(
        `Error ${index}`,
        new Date(`2026-07-29T10:00:${String(index).padStart(2, "0")}Z`),
      );
    }

    expect(errors.snapshot()).toHaveLength(10);
    expect(errors.snapshot()[0]).toEqual({
      timestamp: "2026-07-29T10:00:03.000Z",
      message: "Error 3",
    });
    expect(errors.snapshot().at(-1)).toEqual({
      timestamp: "2026-07-29T10:00:12.000Z",
      message: "Error 12",
    });
  });
});
