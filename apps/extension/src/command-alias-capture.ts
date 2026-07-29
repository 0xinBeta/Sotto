import type { ActionCommand } from "@sotto/core";

export type CommandAliasCaptureState =
  | { readonly stage: "idle" }
  | { readonly stage: "phrase" }
  | { readonly stage: "target"; readonly phrase: string }
  | {
      readonly stage: "confirm";
      readonly phrase: string;
      readonly command: ActionCommand;
    };

export class CommandAliasCaptureSession {
  #state: CommandAliasCaptureState = { stage: "idle" };

  get state(): CommandAliasCaptureState {
    return this.#state;
  }

  startPhrase(): void {
    this.#state = { stage: "phrase" };
  }

  startTarget(phrase: string): void {
    this.#state = { stage: "target", phrase };
  }

  capture(command: ActionCommand): boolean {
    if (this.#state.stage !== "target" || command.action === "unknown") {
      return false;
    }
    this.#state = {
      stage: "confirm",
      phrase: this.#state.phrase,
      command,
    };
    return true;
  }

  complete(): void {
    this.#state = { stage: "idle" };
  }

  cancel(): void {
    this.complete();
  }
}
