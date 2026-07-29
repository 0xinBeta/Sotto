export const FRESH_REMINDER_WINDOW_MS = 60_000;

export type SnoozeDelayMinutes = 5 | 10 | 30 | 60;

const SNOOZE_MINUTE_DELAYS = new Map<string, SnoozeDelayMinutes>([
  ["5", 5],
  ["five", 5],
  ["10", 10],
  ["ten", 10],
  ["30", 30],
  ["thirty", 30],
]);

function normalizeTranscript(transcript: string): string {
  return transcript
    .trim()
    .toLocaleLowerCase()
    .replace(/[.!?]+$/u, "")
    .replace(/\s+/gu, " ")
    .replace(/\s+please$/u, "");
}

export function parseSnoozeDelayMinutes(
  transcript: string,
): SnoozeDelayMinutes | undefined {
  const normalized = normalizeTranscript(transcript);
  if (
    normalized === "snooze" ||
    normalized === "snooze reminder" ||
    normalized === "snooze the reminder"
  ) {
    return 10;
  }

  const minutes = /^snooze(?: (?:the )?reminder| it)?(?: for)? (5|five|10|ten|30|thirty) minutes?$/u
    .exec(normalized)?.[1];
  if (minutes !== undefined) return SNOOZE_MINUTE_DELAYS.get(minutes);

  return /^snooze(?: (?:the )?reminder| it)?(?: for)? (?:1|one|an) hour$/u
      .test(normalized)
    ? 60
    : undefined;
}

export class FreshReminderSession {
  #fresh:
    | {
        readonly reminderId: string;
        readonly expiresAt: number;
      }
    | undefined;

  remember(reminderId: string, now = Date.now()): void {
    this.#fresh = {
      reminderId,
      expiresAt: now + FRESH_REMINDER_WINDOW_MS,
    };
  }

  current(now = Date.now()): string | undefined {
    if (!this.#fresh) return undefined;
    if (now > this.#fresh.expiresAt) {
      this.#fresh = undefined;
      return undefined;
    }
    return this.#fresh.reminderId;
  }

  clear(reminderId?: string): void {
    if (
      reminderId === undefined ||
      this.#fresh?.reminderId === reminderId
    ) {
      this.#fresh = undefined;
    }
  }
}
