export const MAX_VISIBLE_NOTE_TAGS = 12;

export interface FilterableNote {
  readonly body: string;
  readonly tag?: string;
}

export interface NoteTagChip {
  readonly tag: string;
  readonly count: number;
}

function canonicalTag(tag: string): string {
  return tag.toLocaleLowerCase("en-US");
}

export function deriveNoteTagChips(
  notes: readonly FilterableNote[],
  maximum = MAX_VISIBLE_NOTE_TAGS,
): readonly NoteTagChip[] {
  const tags = new Map<string, NoteTagChip>();
  for (const note of notes) {
    if (note.tag === undefined) continue;
    const key = canonicalTag(note.tag);
    const current = tags.get(key);
    tags.set(key, {
      tag: current?.tag ?? note.tag,
      count: (current?.count ?? 0) + 1,
    });
  }
  return [...tags.values()]
    .sort(
      (left, right) =>
        right.count - left.count ||
        left.tag.localeCompare(right.tag, "en-US"),
    )
    .slice(0, Math.max(0, maximum));
}

export function filterPanelNotes<TNote extends FilterableNote>(
  notes: readonly TNote[],
  query: string,
  selectedTag?: string,
): readonly TNote[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const normalizedTag = selectedTag === undefined
    ? undefined
    : canonicalTag(selectedTag);
  return notes.filter(
    (note) =>
      (
        normalizedTag === undefined ||
        (
          note.tag !== undefined &&
          canonicalTag(note.tag) === normalizedTag
        )
      ) &&
      (
        !normalizedQuery ||
        note.body.toLocaleLowerCase().includes(normalizedQuery)
      ),
  );
}
