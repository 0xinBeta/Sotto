import { describe, expect, it } from "vitest";

import {
  formatExchangeTimings,
  timingTone,
} from "../src/timings.js";

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
