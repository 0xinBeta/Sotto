import { afterEach, describe, expect, it, vi } from "vitest";

import {
  OpenWakeWordModel,
  WAKE_WORD_NO_SPEECH_TIMEOUT_MS,
  WakeSpeechConfirmGuard,
  WakeWordController,
  type WakeAudioCapture,
  type WakeFrameModel,
} from "../src/wake-word.js";
import {
  normalizeWakeWordEnabled,
  WAKE_WORD_ENABLED_KEY,
  wakeWordIndicatorVisible,
} from "../src/wake-word-settings.js";

class FakeWakeModel implements WakeFrameModel {
  readonly processFrame = vi.fn(async () => 0);
  readonly reset = vi.fn();
  readonly dispose = vi.fn(async () => undefined);
}

class FakeWakeCapture implements WakeAudioCapture {
  readonly start = vi.fn(async (onFrame: (frame: Float32Array) => void) => {
    this.onFrame = onFrame;
  });
  readonly stop = vi.fn(async () => undefined);
  onFrame: ((frame: Float32Array) => void) | undefined;

  emit(frame = new Float32Array(1_280)): void {
    this.onFrame?.(frame);
  }
}

async function flushTasks(count = 8): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve();
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("wake phrase settings", () => {
  it("keeps the experimental feature off unless storage contains true", () => {
    expect(normalizeWakeWordEnabled({})).toBe(false);
    expect(
      normalizeWakeWordEnabled({ [WAKE_WORD_ENABLED_KEY]: false }),
    ).toBe(false);
    expect(
      normalizeWakeWordEnabled({ [WAKE_WORD_ENABLED_KEY]: true }),
    ).toBe(true);
  });

  it("shows the permanent indicator for every enabled runtime state", () => {
    expect(
      wakeWordIndicatorVisible({ enabled: false, state: "disarmed" }),
    ).toBe(false);
    expect(
      wakeWordIndicatorVisible({ enabled: true, state: "armed" }),
    ).toBe(true);
    expect(
      wakeWordIndicatorVisible({ enabled: true, state: "suspended" }),
    ).toBe(true);
  });
});

describe("wake phrase lifecycle", () => {
  function setup(score = 0) {
    const model = new FakeWakeModel();
    model.processFrame.mockResolvedValue(score);
    const captures: FakeWakeCapture[] = [];
    const states: string[] = [];
    const onDetected = vi.fn(async () => undefined);
    const controller = new WakeWordController({
      createModel: async () => model,
      createCapture: () => {
        const capture = new FakeWakeCapture();
        captures.push(capture);
        return capture;
      },
      onDetected,
      onStateChange(_enabled, state) {
        states.push(state);
      },
      yieldControl: async () => undefined,
    });
    return { captures, controller, model, onDetected, states };
  }

  it("does not create a model or microphone while disabled", async () => {
    const createModel = vi.fn(async () => new FakeWakeModel());
    const createCapture = vi.fn(() => new FakeWakeCapture());
    const controller = new WakeWordController({
      createModel,
      createCapture,
      onDetected: vi.fn(),
      yieldControl: async () => undefined,
    });

    await controller.setEnabled(false);

    expect(createModel).not.toHaveBeenCalled();
    expect(createCapture).not.toHaveBeenCalled();
    expect(controller.state).toBe("disarmed");
  });

  it("arms, disarms, and releases all owned resources", async () => {
    const { captures, controller, model, states } = setup();

    await controller.setEnabled(true);
    expect(controller.state).toBe("armed");
    expect(captures).toHaveLength(1);
    expect(captures[0]!.start).toHaveBeenCalledOnce();

    await controller.setEnabled(false);
    expect(captures[0]!.stop).toHaveBeenCalledOnce();
    expect(model.dispose).toHaveBeenCalledOnce();
    expect(controller.state).toBe("disarmed");
    expect(states).toContain("arming");
    expect(states).toContain("armed");
    expect(states.at(-1)).toBe("disarmed");
  });

  it("suspends during a session and starts a fresh capture after it", async () => {
    const { captures, controller, model } = setup();
    await controller.setEnabled(true);
    const first = captures[0]!;

    await controller.setSuspended("session", true);
    expect(controller.state).toBe("suspended");
    expect(first.stop).toHaveBeenCalledOnce();
    first.emit();
    await flushTasks();
    expect(model.processFrame).not.toHaveBeenCalled();

    await controller.setSuspended("session", false);
    expect(controller.state).toBe("armed");
    expect(captures).toHaveLength(2);
  });

  it("waits for active inference before it declares suspension", async () => {
    const { captures, controller, model } = setup();
    let resolveRun: ((score: number) => void) | undefined;
    model.processFrame.mockImplementation(
      () =>
        new Promise<number>((resolve) => {
          resolveRun = resolve;
        }),
    );
    await controller.setEnabled(true);
    captures[0]!.emit();
    await vi.waitFor(() => {
      expect(model.processFrame).toHaveBeenCalledOnce();
    });

    const suspension = controller.setSuspended("session", true);
    await flushTasks();

    expect(captures[0]!.stop).toHaveBeenCalledOnce();
    expect(controller.state).toBe("armed");

    resolveRun?.(0);
    await suspension;

    expect(controller.state).toBe("suspended");
  });

  it("suspends for speech playback until every hold ends", async () => {
    const { captures, controller } = setup();
    await controller.setEnabled(true);

    await controller.setSuspended("playback", true);
    await controller.setSuspended("session", true);
    await controller.setSuspended("playback", false);

    expect(controller.state).toBe("suspended");
    expect(captures).toHaveLength(1);

    await controller.setSuspended("session", false);
    expect(controller.state).toBe("armed");
    expect(captures).toHaveLength(2);
  });

  it("sends raw frames only to the wake model", async () => {
    const { captures, controller, model, onDetected } = setup(0.9);
    await controller.setEnabled(true);
    const frame = new Float32Array(1_280);
    frame[14] = 0.5;

    captures[0]!.emit(frame);
    await vi.waitFor(() => {
      expect(onDetected).toHaveBeenCalledOnce();
    });

    expect(model.processFrame).toHaveBeenCalledOnce();
    expect(model.processFrame).toHaveBeenCalledWith(frame);
    expect(onDetected).toHaveBeenCalledWith();
    expect(controller.state).toBe("suspended");
  });

  it("returns to armed state when confirmed speech does not start", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });
    const guard = new WakeSpeechConfirmGuard();
    const model = new FakeWakeModel();
    model.processFrame.mockResolvedValue(0.9);
    const captures: FakeWakeCapture[] = [];
    let controller: WakeWordController;
    controller = new WakeWordController({
      createModel: async () => model,
      createCapture: () => {
        const capture = new FakeWakeCapture();
        captures.push(capture);
        return capture;
      },
      onDetected() {
        guard.begin(() => {
          void controller.resumeAfterDetection();
        });
      },
      yieldControl: async () => undefined,
    });
    await controller.setEnabled(true);
    captures[0]!.emit();
    await flushTasks();
    expect(controller.state).toBe("suspended");

    await vi.advanceTimersByTimeAsync(WAKE_WORD_NO_SPEECH_TIMEOUT_MS);
    await flushTasks();

    expect(controller.state).toBe("armed");
    expect(captures).toHaveLength(2);
    await controller.dispose();
  });
});

describe("openWakeWord model boundary", () => {
  it("keeps only the graph windows and the 480-sample overlap", async () => {
    const tensorInputs: {
      readonly data: Float32Array;
      readonly dimensions: readonly number[];
    }[] = [];
    const releases = [vi.fn(), vi.fn(), vi.fn()];
    const sessions = [
      {
        inputNames: ["input"],
        outputNames: ["output"],
        run: vi.fn(async () => ({
          output: { data: new Float32Array(8 * 32) },
        })),
        release: releases[0]!,
      },
      {
        inputNames: ["input_1"],
        outputNames: ["embedding"],
        run: vi.fn(async () => ({
          embedding: { data: new Float32Array(96) },
        })),
        release: releases[1]!,
      },
      {
        inputNames: ["x.1"],
        outputNames: ["score"],
        run: vi.fn(async () => ({
          score: { data: new Float32Array([0.2]) },
        })),
        release: releases[2]!,
      },
    ] as const;
    const model = new OpenWakeWordModel({
      melspectrogram: sessions[0],
      embedding: sessions[1],
      classifier: sessions[2],
      createTensor(data, dimensions) {
        tensorInputs.push({ data, dimensions });
        return { data, dimensions };
      },
    });

    await model.processFrame(new Float32Array(1_280));
    await model.processFrame(new Float32Array(1_280));

    expect(tensorInputs.map((input) => input.dimensions)).toEqual([
      [1, 1_280],
      [1, 76, 32, 1],
      [1, 16, 96],
      [1, 1_760],
      [1, 76, 32, 1],
      [1, 16, 96],
    ]);
    await model.dispose();
    expect(releases.every((release) => release.mock.calls.length === 1))
      .toBe(true);
  });
});
