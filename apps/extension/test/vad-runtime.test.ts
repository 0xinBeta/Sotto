import { SileroV5 } from "@ricky0123/vad-web/dist/models/v5.js";
import { describe, expect, it, vi } from "vitest";

describe("VAD model lifecycle", () => {
  it("waits for active frame inference before it releases the session", async () => {
    let resolveRun:
      | ((outputs: {
        readonly stateN: { dispose(): void };
        readonly output: { readonly data: Float32Array };
      }) => void)
      | undefined;
    const run = new Promise<{
      readonly stateN: { dispose(): void };
      readonly output: { readonly data: Float32Array };
    }>((resolve) => {
      resolveRun = resolve;
    });
    const session = {
      run: vi.fn(() => run),
      release: vi.fn(async () => undefined),
    };
    const state = { dispose: vi.fn() };
    const sampleRate = { dispose: vi.fn() };
    const model = new SileroV5(
      session as never,
      state as never,
      sampleRate as never,
      { Tensor: class FakeTensor {} } as never,
    );

    const frameRun = model.process(new Float32Array(512));
    await Promise.resolve();
    const release = model.release();
    await Promise.resolve();

    expect(session.release).not.toHaveBeenCalled();
    expect(state.dispose).not.toHaveBeenCalled();
    expect(sampleRate.dispose).not.toHaveBeenCalled();

    const nextState = { dispose: vi.fn() };
    resolveRun?.({
      stateN: nextState,
      output: { data: new Float32Array([0.25]) },
    });
    await expect(frameRun).resolves.toEqual({
      isSpeech: 0.25,
      notSpeech: 0.75,
    });
    await release;

    expect(session.release).toHaveBeenCalledOnce();
    expect(nextState.dispose).toHaveBeenCalledOnce();
    expect(sampleRate.dispose).toHaveBeenCalledOnce();
  });
});
