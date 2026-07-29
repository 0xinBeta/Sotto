import { appendFile, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const MINIMUM_EVAL_CASES = 402;

export function evaluateEvalCases(cases, minimumCount = MINIMUM_EVAL_CASES) {
  if (!Array.isArray(cases)) {
    throw new TypeError("The eval cases file must contain an array.");
  }
  if (!Number.isSafeInteger(minimumCount) || minimumCount < 0) {
    throw new TypeError("The eval case floor must be a nonnegative integer.");
  }

  return {
    count: cases.length,
    minimumCount,
    passes: cases.length >= minimumCount,
  };
}

function createSummary(result) {
  const status = result.passes ? "Pass" : "Fail";
  return [
    "### Eval case count",
    "",
    "| Cases | Minimum | Status |",
    "| ---: | ---: | :--- |",
    `| ${result.count} | ${result.minimumCount} | ${status} |`,
    "",
  ].join("\n");
}

async function main() {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const casesPath = resolve(repositoryRoot, "evals/cases.json");
  const cases = JSON.parse(await readFile(casesPath, "utf8"));
  const result = evaluateEvalCases(cases);

  console.log(`Eval cases: ${result.count}. Minimum: ${result.minimumCount}.`);

  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, createSummary(result));
  }

  if (!result.passes) {
    throw new Error(
      `The eval case count is below the minimum of ${result.minimumCount}.`,
    );
  }
}

const isDirectRun =
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectRun) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
