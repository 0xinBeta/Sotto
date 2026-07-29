export const WAKE_WORD_ENABLED_KEY = "wakeWordEnabled";
export const WAKE_PHRASE = "Hey Jarvis";
export const WAKE_PHRASE_LABEL =
  'Wake phrase: "Hey Jarvis" (experimental)';

export type WakeWordRuntimeState =
  | "disarmed"
  | "arming"
  | "armed"
  | "suspended"
  | "error";

export interface WakeWordPanelState {
  readonly enabled: boolean;
  readonly state: WakeWordRuntimeState;
}

export function normalizeWakeWordEnabled(
  values: Record<string, unknown>,
): boolean {
  return values[WAKE_WORD_ENABLED_KEY] === true;
}

export function wakeWordIndicatorVisible(
  state: WakeWordPanelState,
): boolean {
  return state.enabled;
}

