import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const GROUPS = [
  ["feat", "Features"],
  ["fix", "Fixes"],
  ["perf", "Performance"],
  ["refactor", "Refactoring"],
  ["docs", "Documentation"],
  ["chore", "Maintenance"],
];

export function parseConventionalCommit(commit) {
  const match =
    /^(feat|fix|perf|refactor|docs|chore)(?:\(([^)]+)\))?(!)?:\s+(.+)$/u.exec(
      commit.subject,
    );

  if (!match) {
    return null;
  }

  return {
    hash: commit.hash,
    type: match[1],
    scope: match[2] ?? null,
    breaking: Boolean(match[3]),
    description: match[4],
  };
}

export function generateReleaseNotes(commits, previousTag = null) {
  const grouped = new Map(GROUPS.map(([type]) => [type, []]));

  for (const commit of commits) {
    const parsed = parseConventionalCommit(commit);
    if (parsed) {
      grouped.get(parsed.type).push(parsed);
    }
  }

  const lines = [
    "# Release notes",
    "",
    previousTag
      ? `Changes since \`${previousTag}\`.`
      : "Changes in this release.",
  ];
  let changeCount = 0;

  for (const [type, heading] of GROUPS) {
    const changes = grouped.get(type);
    if (changes.length === 0) {
      continue;
    }

    lines.push("", `## ${heading}`, "");
    for (const change of changes) {
      const scope = change.scope ? `**${change.scope}:** ` : "";
      const breaking = change.breaking ? "**Breaking:** " : "";
      const shortHash = change.hash.slice(0, 7);
      lines.push(
        `- ${scope}${breaking}${change.description} (\`${shortHash}\`)`,
      );
      changeCount += 1;
    }
  }

  if (changeCount === 0) {
    lines.push("", "No conventional commit changes.");
  }

  return `${lines.join("\n")}\n`;
}

function runGit(arguments_) {
  return execFileSync("git", arguments_, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function findPreviousTag(currentTag) {
  try {
    return (
      runGit([
        "describe",
        "--tags",
        "--abbrev=0",
        "--match",
        "v*",
        `${currentTag}^`,
      ]) || null
    );
  } catch {
    return null;
  }
}

function readCommits(range) {
  const output = runGit(["log", range, "--format=%H%x09%s"]);
  if (!output) {
    return [];
  }

  return output.split("\n").map((line) => {
    const separator = line.indexOf("\t");
    return {
      hash: line.slice(0, separator),
      subject: line.slice(separator + 1),
    };
  });
}

function main() {
  const currentTag =
    process.env.GITHUB_REF_NAME ??
    runGit(["describe", "--tags", "--exact-match", "--match", "v*"]);
  const previousTag = findPreviousTag(currentTag);
  const range = previousTag ? `${previousTag}..${currentTag}` : currentTag;
  process.stdout.write(generateReleaseNotes(readCommits(range), previousTag));
}

const isDirectRun =
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectRun) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
