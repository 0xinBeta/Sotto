import { describe, expect, it } from "vitest";

import {
  findBestReminderMatch,
  ReminderSelectionSession,
} from "../src/reminder-selection.js";

const reminders = [
  { id: "build", text: "Check the build" },
  { id: "oven", text: "Check the oven" },
  { id: "report", text: "Send the report" },
] as const;

describe("reminder selection", () => {
  it("uses the tab fuzzy matcher pattern for reminder text", () => {
    expect(findBestReminderMatch(reminders, "chek the bild")?.id).toBe(
      "build",
    );
    expect(
      findBestReminderMatch(reminders, "weather forecast tomorrow"),
    ).toBeUndefined();
  });

  it("holds several reminders for one local follow-up", () => {
    const session = new ReminderSelectionSession(() => 1_000);
    session.request(reminders);

    expect(session.resolve("send report")).toEqual({
      kind: "matched",
      reminder: reminders[2],
    });
    expect(session.resolve("check the oven")).toEqual({ kind: "none" });
  });

  it("keeps the selection active after a weak match", () => {
    const session = new ReminderSelectionSession(() => 1_000);
    session.request(reminders);

    expect(session.resolve("not represented")).toEqual({
      kind: "unmatched",
    });
    expect(session.resolve("oven")).toEqual({
      kind: "matched",
      reminder: reminders[1],
    });
  });
});
