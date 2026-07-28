import { describe, expect, it } from "vitest";

import { computeRms, smoothMicLevel } from "../src/mic-level.js";

describe("microphone level", () => {
  it("computes silence and full-scale RMS within the meter bounds", () => {
    expect(computeRms(new Float32Array(256))).toBe(0);
    expect(computeRms(Float32Array.from({ length: 256 }, () => 1))).toBe(1);
  });

  it("uses fast attack and slow decay", () => {
    let level = 0;
    for (let sample = 0; sample < 6; sample += 1) {
      level = smoothMicLevel(level, 1);
    }
    expect(level).toBeGreaterThan(0.99);

    const decayed = smoothMicLevel(level, 0);
    expect(decayed).toBeGreaterThan(0.85);
    expect(decayed).toBeLessThan(level);
    expect(smoothMicLevel(0, 0)).toBe(0);
  });
});
