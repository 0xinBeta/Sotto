import { appendFile, readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const CHROME_VERSION_FLOOR = 138;

export const CHROME_FLOOR_TOKENS = [
  {
    token: "chrome.storage.session",
    minVersion: 102,
    sourceUrl:
      "https://developer.chrome.com/docs/extensions/reference/api/storage#property-session",
  },
  {
    token: "persistAcrossSessions",
    minVersion: 150,
    sourceUrl:
      "https://developer.chrome.com/docs/extensions/reference/api/alarms#type-AlarmCreateInfo",
  },
  {
    token: "chrome.sidePanel.getLayout",
    minVersion: 140,
    sourceUrl:
      "https://developer.chrome.com/docs/extensions/reference/api/sidePanel#method-getLayout",
  },
  {
    token: "chrome.sidePanel.close",
    minVersion: 141,
    sourceUrl:
      "https://developer.chrome.com/docs/extensions/reference/api/sidePanel#method-close",
  },
  {
    token: "chrome.sidePanel.onOpened",
    minVersion: 141,
    sourceUrl:
      "https://developer.chrome.com/docs/extensions/reference/api/sidePanel#event-onOpened",
  },
  {
    token: "chrome.sidePanel.onClosed",
    minVersion: 142,
    sourceUrl:
      "https://developer.chrome.com/docs/extensions/reference/api/sidePanel#event-onClosed",
  },
  // These milestones apply to web exposure. The Prompt API page lists
  // Chrome 138 for extension exposure.
  {
    token: "LanguageModel.availability",
    minVersion: 148,
    sourceUrl: "https://developer.chrome.com/docs/ai/prompt-api",
  },
  {
    token: "LanguageModel.params",
    minVersion: 148,
    sourceUrl: "https://developer.chrome.com/blog/chrome-148-beta#prompt-api",
  },
];

function getAllowedToken(line) {
  const match = /\/\/\s*chrome-floor-allow:\s*(\S+)\s+\S.*$/.exec(line);
  return match?.[1];
}

export function scanChromeFloor(
  files,
  tokens = CHROME_FLOOR_TOKENS,
  floor = CHROME_VERSION_FLOOR,
) {
  const hits = [];
  const newerTokens = tokens.filter(({ minVersion }) => minVersion > floor);

  for (const file of files) {
    const lines = file.contents.split(/\r?\n/);

    for (const [index, line] of lines.entries()) {
      const allowedOnLine = getAllowedToken(line);
      const allowedOnPreviousLine =
        index === 0 ? undefined : getAllowedToken(lines[index - 1]);

      for (const entry of newerTokens) {
        const column = line.indexOf(entry.token);
        if (column === -1) continue;
        if (
          allowedOnLine === entry.token ||
          allowedOnPreviousLine === entry.token
        ) {
          continue;
        }

        hits.push({
          path: file.path,
          line: index + 1,
          column: column + 1,
          ...entry,
        });
      }
    }
  }

  return hits;
}

async function collectFiles(directory, repositoryRoot) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const entryPath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(entryPath, repositoryRoot)));
    } else if (entry.isFile()) {
      files.push({
        path: relative(repositoryRoot, entryPath).split(sep).join("/"),
        contents: await readFile(entryPath, "utf8"),
      });
    }
  }

  return files;
}

async function getSourceFiles(repositoryRoot) {
  const files = await collectFiles(
    resolve(repositoryRoot, "apps/extension/src"),
    repositoryRoot,
  );
  const packagesDirectory = resolve(repositoryRoot, "packages");
  const packages = await readdir(packagesDirectory, { withFileTypes: true });

  for (const entry of packages.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (!entry.isDirectory()) continue;

    const sourceDirectory = resolve(packagesDirectory, entry.name, "src");
    try {
      files.push(...(await collectFiles(sourceDirectory, repositoryRoot)));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  return files;
}

function createSummary(hits) {
  const lines = ["### Chrome version floor", ""];

  if (hits.length === 0) {
    lines.push(
      `No Chrome API usage exceeds Chrome ${CHROME_VERSION_FLOOR}.`,
      "",
    );
    return lines.join("\n");
  }

  lines.push(
    "| Location | Token | Minimum Chrome | Source |",
    "| :--- | :--- | ---: | :--- |",
    ...hits.map(
      (hit) =>
        `| \`${hit.path}:${hit.line}\` | \`${hit.token}\` | ${hit.minVersion} | [Chrome docs](${hit.sourceUrl}) |`,
    ),
    "",
  );
  return lines.join("\n");
}

async function main() {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const hits = scanChromeFloor(await getSourceFiles(repositoryRoot));

  if (hits.length === 0) {
    console.log(
      `Chrome floor check passed. No API usage exceeds Chrome ${CHROME_VERSION_FLOOR}.`,
    );
  } else {
    for (const hit of hits) {
      console.error(
        `${hit.path}:${hit.line}:${hit.column} ${hit.token} requires Chrome ${hit.minVersion}. ${hit.sourceUrl}`,
      );
    }
  }

  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, createSummary(hits));
  }

  if (hits.length > 0) {
    throw new Error(
      `${hits.length} Chrome API token${hits.length === 1 ? " exceeds" : "s exceed"} the Chrome ${CHROME_VERSION_FLOOR} floor.`,
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
