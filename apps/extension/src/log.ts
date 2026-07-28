export interface LogEntry {
  readonly kind: string;
  readonly text: string;
  readonly count: number;
}

export interface LogEntryDecision {
  readonly entry: LogEntry;
  readonly collapsed: boolean;
}

export function nextLogEntry(
  previous: LogEntry | undefined,
  kind: string,
  text: string,
): LogEntryDecision {
  const collapsed =
    previous?.kind === kind &&
    previous.text === text;
  return {
    entry: {
      kind,
      text,
      count: collapsed ? previous.count + 1 : 1,
    },
    collapsed,
  };
}
