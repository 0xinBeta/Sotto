import { findBestTabMatch } from "@sotto/actions";
import { CONFIRMATION_TIMEOUT_MS } from "./confirmation.js";

export interface MatchableReminder {
  readonly id: string;
  readonly text: string;
}

export function findBestReminderMatch<
  TReminder extends MatchableReminder,
>(
  reminders: readonly TReminder[],
  transcript: string,
): TReminder | undefined {
  return findBestTabMatch(
    reminders.map((reminder) => ({
      reminder,
      title: reminder.text,
    })),
    transcript,
  )?.reminder;
}

export type ReminderSelectionResolution<
  TReminder extends MatchableReminder,
> =
  | { readonly kind: "none" }
  | { readonly kind: "unmatched" }
  | { readonly kind: "matched"; readonly reminder: TReminder };

export class ReminderSelectionSession<
  TReminder extends MatchableReminder,
> {
  #pending:
    | {
      readonly reminders: readonly TReminder[];
      readonly expiresAt: number;
    }
    | undefined;

  constructor(
    readonly now: () => number = () => Date.now(),
    readonly timeoutMs = CONFIRMATION_TIMEOUT_MS,
  ) {}

  request(reminders: readonly TReminder[]): void {
    this.#pending = {
      reminders: [...reminders],
      expiresAt: this.now() + this.timeoutMs,
    };
  }

  resolve(transcript: string): ReminderSelectionResolution<TReminder> {
    const pending = this.#pending;
    if (!pending) return { kind: "none" };
    if (this.now() > pending.expiresAt) {
      this.#pending = undefined;
      return { kind: "none" };
    }

    const reminder = findBestReminderMatch(
      pending.reminders,
      transcript,
    );
    if (!reminder) return { kind: "unmatched" };
    this.#pending = undefined;
    return { kind: "matched", reminder };
  }

  clear(): void {
    this.#pending = undefined;
  }
}
