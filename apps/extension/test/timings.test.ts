import { describe, expect, it } from "vitest";

import {
  ExchangeTimingBuffer,
  formatExchangeTimings,
  nearestRankPercentile,
  timingTone,
} from "../src/timings.js";

describe("latency statistics", () => {
  it("uses nearest-rank percentiles for odd, even, one, and two samples", () => {
    expect(nearestRankPercentile([5, 1, 3], 50)).toBe(3);
    expect(nearestRankPercentile([5, 1, 3], 95)).toBe(5);
    expect(nearestRankPercentile([4, 1, 3, 2], 50)).toBe(2);
    expect(nearestRankPercentile([4, 1, 3, 2], 95)).toBe(4);
    expect(nearestRankPercentile([7], 50)).toBe(7);
    expect(nearestRankPercentile([7], 95)).toBe(7);
    expect(nearestRankPercentile([8, 4], 50)).toBe(4);
    expect(nearestRankPercentile([8, 4], 95)).toBe(8);
  });

  it("keeps only the last 50 timing records", () => {
    const buffer = new ExchangeTimingBuffer();
    for (let index = 0; index < 52; index += 1) {
      buffer.add({ input: "typed", parseMs: index });
    }

    expect(buffer.snapshot()).toHaveLength(50);
    expect(buffer.snapshot()[0]).toEqual({
      input: "typed",
      parseMs: 2,
    });
    expect(buffer.snapshot().at(-1)).toEqual({
      input: "typed",
      parseMs: 51,
    });
  });

  it("excludes missing stages and includes each measured total", () => {
    const buffer = new ExchangeTimingBuffer();
    buffer.add({
      input: "typed",
      parseMs: 100,
      actionMs: 20,
    });
    buffer.add({
      input: "voice",
      sttMs: 50,
      parseMs: 200,
      actionMs: 30,
    });

    expect(buffer.statistics()).toEqual({
      sampleCount: 2,
      stt: { sampleCount: 1, p50Ms: 50, p95Ms: 50 },
      parse: { sampleCount: 2, p50Ms: 100, p95Ms: 200 },
      act: { sampleCount: 2, p50Ms: 20, p95Ms: 30 },
      voice: { sampleCount: 0 },
      total: { sampleCount: 2, p50Ms: 120, p95Ms: 280 },
    });
  });
});

describe("exchange timing display", () => {
  it("renders typed input and skips missing stages", () => {
    const display = formatExchangeTimings({
      input: "typed",
      parseMs: 310.4,
      voiceMs: 380.2,
    });

    expect(display).toMatchObject({
      stages: "typed · parse 310ms · voice 380ms",
      total: "total 691ms",
      tone: "green",
    });
    expect(display?.totalMs).toBeCloseTo(690.6);
  });

  it("uses the exact total color boundaries", () => {
    expect(timingTone(1_999.999)).toBe("green");
    expect(timingTone(2_000)).toBe("amber");
    expect(timingTone(3_499.999)).toBe("amber");
    expect(timingTone(3_500)).toBe("red");
  });
});
