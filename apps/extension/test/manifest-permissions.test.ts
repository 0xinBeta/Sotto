import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface ExtensionManifest {
  readonly permissions: readonly string[];
  readonly optional_host_permissions: readonly string[];
  readonly host_permissions: readonly string[];
  readonly content_security_policy: Readonly<Record<string, string>>;
  readonly commands: Readonly<Record<string, unknown>>;
  readonly minimum_chrome_version: string;
  readonly default_locale: string;
}

function readManifest(url: URL): ExtensionManifest {
  return JSON.parse(readFileSync(url, "utf8")) as ExtensionManifest;
}

function trustSurface(manifest: ExtensionManifest) {
  return {
    permissions: [...manifest.permissions].sort(),
    optional_host_permissions: manifest.optional_host_permissions,
    host_permissions: manifest.host_permissions,
    content_security_policy: manifest.content_security_policy,
    command_keys: Object.keys(manifest.commands).sort(),
    minimum_chrome_version: manifest.minimum_chrome_version,
    default_locale: manifest.default_locale,
  };
}

function declaredPermissions(manifest: ExtensionManifest): string[] {
  return [
    ...manifest.permissions,
    ...manifest.host_permissions,
    ...manifest.optional_host_permissions,
  ].sort();
}

function documentedPermissions(url: URL): string[] {
  const blocks = readFileSync(url, "utf8").trim().split(/\r?\n\r?\n/u);
  return blocks.map((block) => {
    const lines = block.split(/\r?\n/u);
    const match = /^Permission: (.+)$/u.exec(lines[0] ?? "");
    if (!match || lines.length !== 2 || !lines[1]?.trim()) {
      throw new Error(
        "Each permission needs a heading and one justification paragraph",
      );
    }
    return match[1];
  }).sort();
}

const sourceManifestUrl = new URL(
  "../public/manifest.json",
  import.meta.url,
);
const distManifestUrl = new URL("../dist/manifest.json", import.meta.url);
const permissionJustificationsUrl = new URL(
  "../../../store/permissions-justifications.txt",
  import.meta.url,
);
const sourceManifest = readManifest(sourceManifestUrl);

/*
 * These values define Sotto's trust surface. Any change must be deliberate,
 * reviewed, and explained in the commit message.
 *
 * activeTab: Run a user command on the active tab.
 * alarms: Start local reminder alarms.
 * bookmarks: Add or remove a bookmark after a user command.
 * clipboardWrite: Copy text and screenshots after a user command.
 * downloads: Save user-requested files to Downloads.
 * notifications: Show local reminder notifications.
 * offscreen: Run microphone, speech, and local model work.
 * scripting: Read or control a page after a user command.
 * sessions: Reopen a recently closed tab.
 * sidePanel: Show Sotto's main interface.
 * storage: Save local settings, notes, and model state.
 * tabs: List, switch, close, and mute tabs.
 * tts: Speak responses with a local system voice.
 * https://huggingface.co/*: Download pinned model files.
 * https://*.huggingface.co/*: Download pinned model files from subdomains.
 * https://*.hf.co/*: Download pinned model files from the Hugging Face CDN.
 * <all_urls>: Capture the visible tab after the one-time user grant.
 */
const expectedTrustSurface = {
  permissions: [
    "activeTab",
    "alarms",
    "bookmarks",
    "clipboardWrite",
    "downloads",
    "notifications",
    "offscreen",
    "scripting",
    "sessions",
    "sidePanel",
    "storage",
    "tabs",
    "tts",
  ],
  optional_host_permissions: ["<all_urls>"],
  host_permissions: [
    "https://huggingface.co/*",
    "https://*.huggingface.co/*",
    "https://*.hf.co/*",
  ],
  content_security_policy: {
    extension_pages:
      "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; worker-src 'self';",
  },
  command_keys: ["read-this-page", "toggle-sotto"],
  minimum_chrome_version: "138",
  default_locale: "en",
};

describe("manifest trust surface", () => {
  it("matches the reviewed source manifest values", () => {
    expect(trustSurface(sourceManifest)).toEqual(expectedTrustSurface);
  });

  it("documents every declared permission in the store listing", () => {
    expect(documentedPermissions(permissionJustificationsUrl)).toEqual(
      declaredPermissions(sourceManifest),
    );
  });

  it.skipIf(!existsSync(distManifestUrl))(
    "keeps the built manifest identical to the source trust surface",
    () => {
      expect(trustSurface(readManifest(distManifestUrl))).toEqual(
        trustSurface(sourceManifest),
      );
    },
  );
});
