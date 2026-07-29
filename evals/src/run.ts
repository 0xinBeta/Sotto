import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import type { ActionCommand } from "@sotto/core";

export interface EvalCase {
  readonly id: string;
  readonly transcript: string;
  readonly memory?: readonly EvalMemoryExchange[];
  readonly expected: ActionCommand;
}

export interface EvalMemoryExchange {
  readonly transcript: string;
  readonly command: ActionCommand;
  readonly resultSummary: string;
}

export interface EvalOutcome {
  readonly id: string;
  readonly pass: boolean;
  readonly actual: ActionCommand;
  readonly expected: ActionCommand;
}

export interface EvalSummary {
  readonly passed: number;
  readonly failed: number;
  readonly outcomes: readonly EvalOutcome[];
}

export type EvalParser = (
  transcript: string,
  memory?: readonly EvalMemoryExchange[],
) => Promise<ActionCommand>;

export async function loadCases(
  url = new URL("../cases.json", import.meta.url),
): Promise<readonly EvalCase[]> {
  const parsed: unknown = JSON.parse(await readFile(url, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new TypeError("evals/cases.json must contain an array");
  }
  return parsed as readonly EvalCase[];
}

export async function runEvals(
  parse: EvalParser,
  cases: readonly EvalCase[],
): Promise<EvalSummary> {
  const outcomes: EvalOutcome[] = [];
  for (const testCase of cases) {
    const actual = await parse(testCase.transcript, testCase.memory);
    outcomes.push({
      id: testCase.id,
      pass: isDeepStrictEqual(actual, testCase.expected),
      actual,
      expected: testCase.expected,
    });
  }

  const passed = outcomes.filter((outcome) => outcome.pass).length;
  return {
    passed,
    failed: outcomes.length - passed,
    outcomes,
  };
}

async function main(): Promise<void> {
  const cases = await loadCases();
  const groups = new Map<string, number>();
  for (const testCase of cases) {
    const operationValue = (
      testCase.expected as ActionCommand & { readonly operation?: unknown }
    ).operation;
    const operation =
      typeof operationValue === "string" ? `/${operationValue}` : "";
    const key = `${testCase.expected.action}${operation}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }

  console.log(`Loaded ${cases.length} intent eval cases.`);
  console.log(
    [...groups.entries()]
      .map(([group, count]) => `${group}: ${count}`)
      .join(", "),
  );
  console.log("Import runEvals() and supply a Nano-backed parser to execute them.");
}

const entry = process.argv[1];
if (
  entry !== undefined &&
  pathToFileURL(fileURLToPath(pathToFileURL(entry))).href === import.meta.url
) {
  await main();
}
