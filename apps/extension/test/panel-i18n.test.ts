import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PANEL_MESSAGE_KEYS,
  type PanelMessageKey,
} from "../src/panel-i18n-keys.js";
import { t } from "../src/panel-i18n.js";

interface LocaleMessage {
  readonly message: string;
}

const messages = JSON.parse(
  readFileSync(
    new URL("../public/_locales/en/messages.json", import.meta.url),
    "utf8",
  ),
) as Record<string, LocaleMessage>;

const panelMarkup = readFileSync(
  new URL("../sidepanel.html", import.meta.url),
  "utf8",
);

const manifest = JSON.parse(
  readFileSync(
    new URL("../public/manifest.json", import.meta.url),
    "utf8",
  ),
) as Record<string, unknown>;

const panelSources = [
  "model-manager.ts",
  "recovery-hint.ts",
  "setup-view.ts",
  "sidepanel.ts",
  "timings.ts",
].map((file) =>
  readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8")
);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("panel i18n messages", () => {
  it("configures English as the manifest fallback locale", () => {
    expect(manifest).toMatchObject({
      name: "__MSG_extensionName__",
      description: "__MSG_extensionDescription__",
      default_locale: "en",
    });
  });

  it("contains every typed, static, and runtime panel key", () => {
    expect(new Set(PANEL_MESSAGE_KEYS)).toEqual(
      new Set(Object.keys(messages)),
    );

    const referencedKeys = new Set<string>();
    for (const source of panelSources) {
      for (const match of source.matchAll(/\bt\(\s*"([^"]+)"/g)) {
        referencedKeys.add(match[1]!);
      }
    }
    for (const match of panelMarkup.matchAll(
      /data-i18n(?:-(?:aria-label|placeholder|prepend|append))?="([^"]+)"/g,
    )) {
      referencedKeys.add(match[1]!);
    }

    for (const key of referencedKeys) {
      expect(
        messages[key]?.message,
        `Missing locale message: ${key}`,
      ).toBeTruthy();
      expect(PANEL_MESSAGE_KEYS).toContain(key as PanelMessageKey);
    }
  });

  it("uses fallback substitution when Chrome returns an empty message", () => {
    const getMessage = vi.fn(() => "");
    vi.stubGlobal("chrome", { i18n: { getMessage } });

    expect(t("importConfirm", "3")).toBe(
      "Import 3 notes and settings? This replaces your settings.",
    );
    expect(getMessage).toHaveBeenCalledWith("importConfirm", ["3"]);
  });

  it("uses the message returned by chrome.i18n", () => {
    const getMessage = vi.fn(() => "Localized panel text");
    vi.stubGlobal("chrome", { i18n: { getMessage } });

    expect(t("setupHeading")).toBe("Localized panel text");
    expect(getMessage).toHaveBeenCalledWith("setupHeading", []);
  });

  it("uses the embedded English fallback without chrome.i18n", () => {
    vi.stubGlobal("chrome", {});

    expect(t("statusOnDevice")).toBe("On device");
  });

  it("keeps key panel copy identical", () => {
    vi.stubGlobal("chrome", {});

    expect({
      setup: t("setupHeading"),
      listen: t("holdToTalk"),
      transcript: t("transcriptPlaceholder"),
      clipboard: t("copyAndContinue"),
    }).toMatchInlineSnapshot(`
      {
        "clipboard": "Copy & continue",
        "listen": "Hold to talk",
        "setup": "Set up Sotto.",
        "transcript": "Your words will appear here.",
      }
    `);
  });
});
