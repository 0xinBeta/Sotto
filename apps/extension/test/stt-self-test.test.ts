import { describe, expect, it } from "vitest";

import { loadSttSelfTestPcm } from "../src/stt-self-test.js";

describe("bundled STT self-test fixture", () => {
  it("decodes to short, finite, non-silent 16 kHz PCM", async () => {
    const audio = await loadSttSelfTestPcm();
    let peak = 0;
    for (const sample of audio) {
      expect(Number.isFinite(sample)).toBe(true);
      peak = Math.max(peak, Math.abs(sample));
    }

    expect(audio.length).toBeGreaterThan(4_800);
    expect(audio.length).toBeLessThan(32_000);
    expect(peak).toBeGreaterThan(0.01);
  });
});
