import type { ActionCommand } from "@sotto/core";

export const CONFIRMATION_TIMEOUT_MS = 15_000;

const YES_PATTERN =
  /^(?:yes(?:,?\s+please)?|yeah|yep|confirm|do it|go ahead|please do|ok(?:ay)?|sure)[\s.!?]*$/iu;

export function isConfirmationPhrase(transcript: string): boolean {
  return YES_PATTERN.test(transcript.trim());
}

interface PendingConfirmation {
  readonly command: ActionCommand;
  readonly expiresAt: number;
}

export type ConfirmationResolution =
  | { readonly kind: "none" }
  | {
      readonly kind: "confirmed";
      readonly command: ActionCommand;
    }
  | { readonly kind: "cancelled" };

export class ConfirmationSession {
  #pending: PendingConfirmation | undefined;

  get hasPending(): boolean {
    if (this.#pending && this.now() > this.#pending.expiresAt) {
      this.#pending = undefined;
    }
    return this.#pending !== undefined;
  }

  constructor(
    readonly now: () => number = () => Date.now(),
    readonly timeoutMs = CONFIRMATION_TIMEOUT_MS,
  ) {}

  request(command: ActionCommand): void {
    this.#pending = {
      command,
      expiresAt: this.now() + this.timeoutMs,
    };
  }

  resolve(
    transcript: string,
    command?: ActionCommand,
  ): ConfirmationResolution {
    const pending = this.#pending;
    if (!pending) return { kind: "none" };
    if (command?.action === "repeat") return { kind: "none" };

    this.#pending = undefined;
    if (
      this.now() <= pending.expiresAt &&
      isConfirmationPhrase(transcript)
    ) {
      return { kind: "confirmed", command: pending.command };
    }
    return { kind: "cancelled" };
  }

  clear(): void {
    this.#pending = undefined;
  }
}
