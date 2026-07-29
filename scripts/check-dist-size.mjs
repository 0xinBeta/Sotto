import { appendFile, readdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DIST_SIZE_LIMIT_BYTES = 100 * 1024 * 1024;

export function evaluateDistSize(
  totalBytes,
  limitBytes = DIST_SIZE_LIMIT_BYTES,
) {
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 0) {
    throw new TypeError("The total byte count must be a nonnegative integer.");
  }
  if (!Number.isSafeInteger(limitBytes) || limitBytes < 0) {
    throw new TypeError("The byte limit must be a nonnegative integer.");
  }

  return {
    totalBytes,
    limitBytes,
    passes: totalBytes <= limitBytes,
  };
}

export async function getDirectorySize(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const sizes = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = resolve(directory, entry.name);

      if (entry.isDirectory()) {
        return getDirectorySize(entryPath);
      }
      if (entry.isFile()) {
        return (await stat(entryPath)).size;
      }
      return 0;
    }),
  );

  return sizes.reduce((total, size) => total + size, 0);
}

function formatMiB(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function createSummary(result) {
  const status = result.passes ? "Pass" : "Fail";
  return [
    "### Extension bundle size",
    "",
    "| Total | Limit | Status |",
    "| ---: | ---: | :--- |",
    `| ${result.totalBytes.toLocaleString("en-US")} bytes (${formatMiB(result.totalBytes)}) | ${result.limitBytes.toLocaleString("en-US")} bytes (${formatMiB(result.limitBytes)}) | ${status} |`,
    "",
  ].join("\n");
}

async function main() {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const distDirectory = resolve(repositoryRoot, "apps/extension/dist");
  const result = evaluateDistSize(await getDirectorySize(distDirectory));

  console.log(
    `Extension bundle: ${result.totalBytes.toLocaleString("en-US")} bytes (${formatMiB(result.totalBytes)}).`,
  );
  console.log(
    `Bundle limit: ${result.limitBytes.toLocaleString("en-US")} bytes (${formatMiB(result.limitBytes)}).`,
  );

  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, createSummary(result));
  }

  if (!result.passes) {
    throw new Error("The extension bundle is larger than the 100 MiB limit.");
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
