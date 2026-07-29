import { describe, expect, it } from "vitest";

import {
  FRESH_REMINDER_WINDOW_MS,
  FreshReminderSession,
  parseSnoozeDelayMinutes,
} from "../src/reminder-snooze.js";

describe("reminder snooze voice input", () => {
  it.each([
    ["snooze", 10],
    ["snooze ten minutes", 10],
    ["snooze for five minutes", 5],
    ["snooze it for 30 minutes", 30],
    ["snooze the reminder for one hour", 60],
    ["snooze for an hour please", 60],
  ])("parses %s as %i minutes", (transcript, expected) => {
    expect(parseSnoozeDelayMinutes(transcript)).toBe(expected);
  });

  it.each([
    "snooze for 15 minutes",
    "snooze for two hours",
    "snooze until tomorrow",
    "snooze this page",
  ])("rejects the unsupported duration in %s", (transcript) => {
    expect(parseSnoozeDelayMinutes(transcript)).toBeUndefined();
  });

  it("expires the fired reminder after 60 seconds", () => {
    const session = new FreshReminderSession();
    session.remember("fresh", 1_000);

    expect(session.current(1_000 + FRESH_REMINDER_WINDOW_MS)).toBe("fresh");
    expect(session.current(1_001 + FRESH_REMINDER_WINDOW_MS)).toBeUndefined();
  });
});
