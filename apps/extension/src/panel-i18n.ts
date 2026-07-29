import {
  EN_PANEL_MESSAGES,
  isPanelMessageKey,
  type PanelMessageKey,
} from "./panel-i18n-keys.js";

function substitute(message: string, substitutions: readonly string[]): string {
  return message.replace(
    /\$(\d+)/g,
    (placeholder, index: string) =>
      substitutions[Number(index) - 1] ?? placeholder,
  );
}

export function t(
  key: PanelMessageKey,
  ...substitutions: string[]
): string {
  try {
    const message = globalThis.chrome?.i18n?.getMessage(
      key,
      substitutions,
    );
    if (message) return message;
  } catch {
    // Tests and non-extension documents use the embedded English table.
  }
  return substitute(EN_PANEL_MESSAGES[key], substitutions);
}

function localizeAttribute(
  root: ParentNode,
  dataAttribute: string,
  attribute: string,
): void {
  for (const element of root.querySelectorAll<HTMLElement>(
    `[${dataAttribute}]`,
  )) {
    const key = element.getAttribute(dataAttribute);
    if (!key || !isPanelMessageKey(key)) continue;
    element.setAttribute(attribute, t(key));
  }
}

export function localizePanel(root: ParentNode = document): void {
  if (typeof root.querySelectorAll !== "function") return;
  for (const element of root.querySelectorAll<HTMLElement>("[data-i18n]")) {
    const key = element.getAttribute("data-i18n");
    if (!key || !isPanelMessageKey(key)) continue;
    element.textContent = t(key);
  }
  for (const [dataAttribute, position] of [
    ["data-i18n-prepend", "prepend"],
    ["data-i18n-append", "append"],
  ] as const) {
    for (const element of root.querySelectorAll<HTMLElement>(
      `[${dataAttribute}]`,
    )) {
      const key = element.getAttribute(dataAttribute);
      if (!key || !isPanelMessageKey(key)) continue;
      element[position](element.ownerDocument.createTextNode(t(key)));
    }
  }
  localizeAttribute(
    root,
    "data-i18n-aria-label",
    "aria-label",
  );
  localizeAttribute(root, "data-i18n-placeholder", "placeholder");
}
