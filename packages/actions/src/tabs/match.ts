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

export function scoreFuzzyMatch(candidate: string, target: string): number {
  const query = normalize(target);
  const normalizedCandidate = normalize(candidate);
  if (!query || !normalizedCandidate) return 0;

  let best = 0;
  if (normalizedCandidate === query) best = 1;
  if (normalizedCandidate.startsWith(query)) best = Math.max(best, 0.94);
  if (normalizedCandidate.includes(query)) best = Math.max(best, 0.9);

  const words = query.split(" ");
  const wordCoverage =
    words.filter((word) => normalizedCandidate.includes(word)).length /
    words.length;
  best = Math.max(best, wordCoverage * 0.84);

  const distance = editDistance(query, normalizedCandidate);
  const similarity =
    1 - distance / Math.max(query.length, normalizedCandidate.length);
  return Math.max(best, similarity * 0.78);
}

export function scoreTabMatch(tab: MatchableTab, target: string): number {
  return Math.max(
    scoreFuzzyMatch(tab.title ?? "", target),
    scoreFuzzyMatch(tab.url ?? "", target),
  );
}

export function findBestTabMatch<TTab extends MatchableTab>(
  tabs: readonly TTab[],
  target: string,
  minimumScore = 0.42,
  excludedTabId?: number,
): TTab | undefined {
  let best: { tab: TTab; score: number } | undefined;
  for (const tab of tabs) {
    if (excludedTabId !== undefined && tab.id === excludedTabId) continue;
    const score = scoreTabMatch(tab, target);
    if (!best || score > best.score) best = { tab, score };
  }
  return best && best.score >= minimumScore ? best.tab : undefined;
}
