import { describe, expect, it } from "vitest";
import {
  DIST_SIZE_LIMIT_BYTES,
  evaluateDistSize,
} from "./check-dist-size.mjs";
import {
  MINIMUM_EVAL_CASES,
  evaluateEvalCases,
} from "./check-evals-count.mjs";
import { generateReleaseNotes } from "./generate-release-notes.mjs";

describe("dist size check", () => {
  it("accepts a bundle at the limit", () => {
    expect(evaluateDistSize(DIST_SIZE_LIMIT_BYTES).passes).toBe(true);
  });

  it("rejects a bundle above the limit", () => {
    expect(evaluateDistSize(DIST_SIZE_LIMIT_BYTES + 1).passes).toBe(false);
  });
});

describe("eval count check", () => {
  it("accepts the current case floor", () => {
    const cases = Array.from({ length: MINIMUM_EVAL_CASES });
    expect(evaluateEvalCases(cases).passes).toBe(true);
  });

  it("rejects a count below the current case floor", () => {
    const cases = Array.from({ length: MINIMUM_EVAL_CASES - 1 });
    expect(evaluateEvalCases(cases).passes).toBe(false);
  });
});

describe("release notes", () => {
  it("groups conventional commits and ignores other subjects", () => {
    const commits = [
      { hash: "1111111aaaa", subject: "fix: stop duplicate speech" },
      { hash: "2222222bbbb", subject: "feat(tts): add a premium voice" },
      { hash: "3333333cccc", subject: "perf!: reduce model load time" },
      { hash: "4444444dddd", subject: "refactor: split voice settings" },
      { hash: "5555555eeee", subject: "docs: explain local models" },
      { hash: "6666666ffff", subject: "chore: update CI checks" },
      { hash: "7777777gggg", subject: "Merge branch 'main'" },
    ];

    expect(generateReleaseNotes(commits, "v0.3.0")).toBe(`# Release notes

Changes since \`v0.3.0\`.

## Features

- **tts:** add a premium voice (\`2222222\`)

## Fixes

- stop duplicate speech (\`1111111\`)

## Performance

- **Breaking:** reduce model load time (\`3333333\`)

## Refactoring

- split voice settings (\`4444444\`)

## Documentation

- explain local models (\`5555555\`)

## Maintenance

- update CI checks (\`6666666\`)
`);
  });
});
