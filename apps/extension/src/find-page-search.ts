export const FIND_MATCH_HIGHLIGHT = "sotto-find-match";
export const FIND_CURRENT_HIGHLIGHT = "sotto-find-current";

interface SearchTextNode {
  readonly data: string;
}

interface SearchRange<TNode extends SearchTextNode> {
  setStart(node: TNode, offset: number): void;
  setEnd(node: TNode, offset: number): void;
}

interface HighlightRegistryLike<THighlight> {
  set(name: string, highlight: THighlight): unknown;
  delete(name: string): unknown;
}

export function createTextMatchRanges<
  TNode extends SearchTextNode,
  TRange extends SearchRange<TNode>,
>(
  nodes: Iterable<TNode>,
  query: string,
  createRange: () => TRange,
): TRange[] {
  if (query.length === 0) return [];
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(escaped, "giu");
  const ranges: TRange[] = [];

  for (const node of nodes) {
    for (const match of node.data.matchAll(pattern)) {
      if (match.index === undefined || match[0].length === 0) continue;
      const range = createRange();
      range.setStart(node, match.index);
      range.setEnd(node, match.index + match[0].length);
      ranges.push(range);
    }
  }
  return ranges;
}

export function nextMatchIndex(
  matchCount: number,
  currentIndex: number,
): { readonly index: number; readonly wrapped: boolean } {
  if (matchCount < 1) return { index: -1, wrapped: false };
  const index = currentIndex + 1;
  if (index < matchCount) return { index, wrapped: false };
  return { index: 0, wrapped: true };
}

export function applyFindHighlights<TRange, THighlight>(
  ranges: readonly TRange[],
  currentIndex: number,
  registry: HighlightRegistryLike<THighlight>,
  createHighlight: (...ranges: TRange[]) => THighlight,
): void {
  registry.delete(FIND_MATCH_HIGHLIGHT);
  registry.delete(FIND_CURRENT_HIGHLIGHT);
  if (ranges.length === 0) return;

  registry.set(FIND_MATCH_HIGHLIGHT, createHighlight(...ranges));
  const current = ranges[currentIndex];
  if (current !== undefined) {
    registry.set(FIND_CURRENT_HIGHLIGHT, createHighlight(current));
  }
}
