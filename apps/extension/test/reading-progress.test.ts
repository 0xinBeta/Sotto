import { describe, expect, it } from "vitest";

import {
  activeReadingSentenceIndex,
  createReadingPlan,
} from "../src/reading-progress.js";

describe("reading progress", () => {
  it("maps hard chunk boundaries to sentence spans", () => {
    const longSentence = `${"word ".repeat(95).trim()}.`;
    const plan = createReadingPlan(`${longSentence} Next sentence.`);

    expect(plan.sentences).toHaveLength(2);
    expect(plan.chunks.length).toBeGreaterThan(2);
    expect(plan.text).toBe(plan.chunks.map((chunk) => chunk.text).join(" "));

    const firstChunk = plan.chunks[0]!;
    expect(
      activeReadingSentenceIndex(plan, {
        charIndex: firstChunk.end,
        chunkIndex: 0,
        chunkCount: plan.chunks.length,
        eventType: "end",
      }),
    ).toBe(0);

    const firstSentence = plan.sentences[0]!;
    const lastFirstSentenceChunk = plan.chunks.findLastIndex(
      (chunk) => chunk.end === firstSentence.end,
    );
    expect(lastFirstSentenceChunk).toBeGreaterThan(0);
    expect(
      activeReadingSentenceIndex(plan, {
        charIndex: firstSentence.end,
        chunkIndex: lastFirstSentenceChunk,
        chunkCount: plan.chunks.length,
        eventType: "end",
      }),
    ).toBe(1);
  });

  it("keeps abbreviations and exact normalized sentence offsets", () => {
    const plan = createReadingPlan(
      "Dr. Smith paid $3.14.\n\nNext is the U.S. office.",
    );

    expect(plan.sentences.map((sentence) => sentence.text)).toEqual([
      "Dr. Smith paid $3.14.",
      "Next is the U.S. office.",
    ]);
    expect(plan.sentences[0]).toEqual({
      text: "Dr. Smith paid $3.14.",
      start: 0,
      end: "Dr. Smith paid $3.14.".length,
    });
    expect(plan.sentences[1]?.start).toBe(
      "Dr. Smith paid $3.14.".length + 1,
    );
  });
});
