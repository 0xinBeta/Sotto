import { describe, expect, it } from "vitest";

import {
  CONFIRMATION_TIMEOUT_MS,
  ConfirmationSession,
} from "../src/confirmation.js";

const command = {
  action: "notes",
  operation: "delete-last",
} as const;

describe("confirmation session", () => {
  it.each([
    "yes",
    "yes, please",
    "yeah",
    "yep",
    "confirm",
    "do it",
    "go ahead",
    "okay",
    "sure",
  ])(
    "releases the held command for %s",
    (transcript) => {
      const session = new ConfirmationSession(() => 1_000);
      session.request(command);

      expect(session.resolve(transcript)).toEqual({
        kind: "confirmed",
        command,
      });
      expect(session.resolve("yes")).toEqual({ kind: "none" });
    },
  );

  it.each(["no", "no thanks", "cancel that", "show my notes"])(
    "cancels the held command for %s",
    (transcript) => {
      const session = new ConfirmationSession(() => 1_000);
      session.request(command);

      expect(session.resolve(transcript)).toEqual({ kind: "cancelled" });
      expect(session.resolve("yes")).toEqual({ kind: "none" });
    },
  );

  it("expires the held command after 15 seconds", () => {
    let now = 1_000;
    const session = new ConfirmationSession(() => now);
    session.request(command);
    now += CONFIRMATION_TIMEOUT_MS + 1;

    expect(session.resolve("yes")).toEqual({ kind: "cancelled" });
    expect(session.resolve("yes")).toEqual({ kind: "none" });
  });

  it("keeps the held command when the user asks for a repeat", () => {
    const session = new ConfirmationSession(() => 1_000);
    session.request(command);

    expect(
      session.resolve("repeat that", { action: "repeat" }),
    ).toEqual({ kind: "none" });
    expect(session.resolve("yes")).toEqual({
      kind: "confirmed",
      command,
    });
  });
});
