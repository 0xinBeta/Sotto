import messages from "../public/_locales/en/messages.json";

export type PanelMessageKey = keyof typeof messages;

export const PANEL_MESSAGE_KEYS = Object.freeze(
  Object.keys(messages) as PanelMessageKey[],
);

export const EN_PANEL_MESSAGES = Object.freeze(
  Object.fromEntries(
    Object.entries(messages).map(([key, value]) => [key, value.message]),
  ) as Record<PanelMessageKey, string>,
);

export function isPanelMessageKey(value: string): value is PanelMessageKey {
  return Object.hasOwn(EN_PANEL_MESSAGES, value);
}
