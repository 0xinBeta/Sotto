import type { ResponseVerbosity } from "./speech-settings.js";

export const SPOKEN_LINE_KEYS = [
  "done",
  "note-saved",
  "note-deleted",
  "reminder-set",
  "reminder-cancelled",
  "cancelled",
  "tab-opened",
  "tab-closed",
  "tab-reopened",
  "typed",
  "rewritten",
  "searching",
  "screenshot-copied",
] as const;

export type SpokenLineKey = (typeof SPOKEN_LINE_KEYS)[number];

interface SpokenLineVariants {
  readonly normal: string;
  readonly brief: string;
}

const SPOKEN_LINES: Record<SpokenLineKey, SpokenLineVariants> = {
  done: {
    normal: "Done.",
    brief: "Done.",
  },
  "note-saved": {
    normal: "Saved your note.",
    brief: "Saved.",
  },
  "note-deleted": {
    normal: "Deleted the note.",
    brief: "Done.",
  },
  "reminder-set": {
    normal: "Set your reminder.",
    brief: "Saved.",
  },
  "reminder-cancelled": {
    normal: "Cancelled the reminder.",
    brief: "Done.",
  },
  cancelled: {
    normal: "Cancelled.",
    brief: "Cancelled.",
  },
  "tab-opened": {
    normal: "Opened a new tab.",
    brief: "Opened.",
  },
  "tab-closed": {
    normal: "Closed the tab.",
    brief: "Closed.",
  },
  "tab-reopened": {
    normal: "Reopened the last closed tab.",
    brief: "Opened.",
  },
  typed: {
    normal: "Typed it.",
    brief: "Done.",
  },
  rewritten: {
    normal: "Rewrote the selection.",
    brief: "Done.",
  },
  searching: {
    normal: "Searching.",
    brief: "Searching.",
  },
  "screenshot-copied": {
    normal: "Screenshot copied.",
    brief: "Copied.",
  },
};

const SPOKEN_LINE_KEY_BY_NORMAL = new Map(
  SPOKEN_LINE_KEYS.map((key) => [SPOKEN_LINES[key].normal, key]),
);

export interface SelectedSpokenLine {
  readonly text: string;
  readonly key?: SpokenLineKey;
}

export function spokenLine(
  key: SpokenLineKey,
  verbosity: ResponseVerbosity,
): string {
  return SPOKEN_LINES[key][verbosity];
}

export function selectSpokenLine(
  text: string,
  verbosity: ResponseVerbosity,
): SelectedSpokenLine {
  const key = SPOKEN_LINE_KEY_BY_NORMAL.get(text);
  return key === undefined
    ? { text }
    : { text: spokenLine(key, verbosity), key };
}
