import { describe, expect, it } from "vitest";
import { deriveSetupViewState } from "../src/setup-view.js";

describe("guided setup state", () => {
  it("derives each live row state and action", () => {
    const checking = deriveSetupViewState({
      microphone: "unknown",
    });
    expect(checking.rows.map((row) => row.state)).toEqual([
      "pending",
      "pending",
      "pending",
      "pending",
    ]);

    const needsAction = deriveSetupViewState({
      microphone: "denied",
      capture: false,
      nano: "downloadable",
      premiumVoice: "absent",
      premiumSpeech: "not-downloaded",
    });
    expect(needsAction.rows).toMatchObject([
      { id: "microphone", state: "needs-action", action: "microphone" },
      { id: "capture", state: "needs-action", action: "capture" },
      { id: "nano", state: "needs-action", action: "nano" },
      {
        id: "premium",
        state: "needs-action",
        action: "premium-voice",
      },
    ]);

    const downloading = deriveSetupViewState({
      microphone: "granted",
      capture: true,
      nano: "downloading",
      premiumVoice: "ready",
      premiumSpeech: "loading",
    });
    expect(downloading.rows.map((row) => row.state)).toEqual([
      "done",
      "done",
      "pending",
      "pending",
    ]);

    const ready = deriveSetupViewState({
      microphone: "granted",
      capture: true,
      nano: "available",
      premiumVoice: "ready",
      premiumSpeech: "active",
    });
    expect(ready.rows.map((row) => row.state)).toEqual([
      "done",
      "done",
      "done",
      "done",
    ]);
  });

  it("collapses only when all required steps are done", () => {
    const requiredReady = {
      microphone: "granted" as const,
      capture: true,
      nano: "available" as const,
      premiumVoice: "absent" as const,
      premiumSpeech: "not-downloaded" as const,
    };
    expect(deriveSetupViewState(requiredReady).complete).toBe(true);
    expect(
      deriveSetupViewState({
        ...requiredReady,
        nano: "downloadable",
      }).complete,
    ).toBe(false);
  });
});
