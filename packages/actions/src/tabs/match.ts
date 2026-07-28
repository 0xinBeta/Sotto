export interface MatchableTab {
  readonly id?: number | undefined;
  readonly title?: string | undefined;
  readonly url?: string | undefined;
}

function normalize(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function editDistance(left: string, right: string): number {
  if (!left.length) return right.length;
  if (!right.length) return left.length;

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitution =
        previous[rightIndex - 1]! +
        (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1);
      current[rightIndex] = Math.min(
        previous[rightIndex]! + 1,
        current[rightIndex - 1]! + 1,
        substitution,
      );
    }
    previous = current;
  }
  return previous[right.length]!;
}

export function scoreTabMatch(tab: MatchableTab, target: string): number {
  const query = normalize(target);
  if (!query) return 0;

  const title = normalize(tab.title ?? "");
  const url = normalize(tab.url ?? "");
  const candidates = [title, url].filter(Boolean);
  let best = 0;

  for (const candidate of candidates) {
    if (candidate === query) best = Math.max(best, 1);
    if (candidate.startsWith(query)) best = Math.max(best, 0.94);
    if (candidate.includes(query)) best = Math.max(best, 0.9);

    const words = query.split(" ");
    const wordCoverage =
      words.filter((word) => candidate.includes(word)).length / words.length;
    best = Math.max(best, wordCoverage * 0.84);

    const distance = editDistance(query, candidate);
    const similarity = 1 - distance / Math.max(query.length, candidate.length);
    best = Math.max(best, similarity * 0.78);
  }
  return best;
}

export function findBestTabMatch<TTab extends MatchableTab>(
  tabs: readonly TTab[],
  target: string,
  minimumScore = 0.42,
): TTab | undefined {
  let best: { tab: TTab; score: number } | undefined;
  for (const tab of tabs) {
    const score = scoreTabMatch(tab, target);
    if (!best || score > best.score) best = { tab, score };
  }
  return best && best.score >= minimumScore ? best.tab : undefined;
}
