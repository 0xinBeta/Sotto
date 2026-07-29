import {
  EditorGuardError,
  EditorSnapshotSession,
} from "./editor.js";
import type {
  EditorCapture,
  EditorCaptureOptions,
  EditorCommit,
} from "./types.js";

export type TypeBridgeMessage =
  | {
      readonly target: "sotto-type-bridge";
      readonly type: "capture";
      readonly options: EditorCaptureOptions;
      readonly keepAlive: boolean;
      readonly epochNonce: string;
    }
  | {
      readonly target: "sotto-type-bridge";
      readonly type: "commit";
      readonly snapshotId: string;
      readonly text: string;
      readonly inputType: "insertText" | "insertReplacementText";
      readonly rememberAsDictation: boolean;
      readonly keepAlive: boolean;
      readonly epochNonce: string;
    }
  | {
      readonly target: "sotto-type-bridge";
      readonly type: "release";
      readonly epochNonce: string;
    };

export interface TypeBridgeEpoch {
  readonly href: string;
  readonly nonce: string;
}

export type TypeBridgeResponse =
  | {
      readonly ok: true;
      readonly epoch: TypeBridgeEpoch;
      readonly value: EditorCapture | EditorCommit | { readonly released: true };
    }
  | {
      readonly ok: false;
      readonly epoch: TypeBridgeEpoch;
      readonly error: {
        readonly code: string;
        readonly message: string;
      };
    };

interface RuntimeMessageEvent {
  addListener(
    listener: (
      message: unknown,
      sender: unknown,
      sendResponse: (response: TypeBridgeResponse) => void,
    ) => boolean | void,
  ): void;
  removeListener?(
    listener: (
      message: unknown,
      sender: unknown,
      sendResponse: (response: TypeBridgeResponse) => void,
    ) => boolean | void,
  ): void;
}

interface RuntimeLike {
  readonly onMessage: RuntimeMessageEvent;
  sendMessage?(message: unknown): Promise<unknown> | void;
}

interface NavigationWindow {
  readonly location: Pick<Location, "href">;
  addEventListener(
    type: "hashchange" | "popstate",
    listener: EventListener,
  ): void;
  removeEventListener(
    type: "hashchange" | "popstate",
    listener: EventListener,
  ): void;
}

export interface TypeBridgeInstallOptions {
  readonly document?: Document;
  readonly runtime?: RuntimeLike;
  readonly window?: NavigationWindow;
}

const INSTALL_KEY = Symbol.for("sotto.type-content-script-bridge.v0.2");
const METADATA_KEY = Symbol.for(
  "sotto.type-content-script-bridge.navigation.v0.3",
);
const NAVIGATION_POLL_MS = 250;

interface InstalledMetadata {
  readonly href: string;
  readonly handleNavigation: () => void;
}

type InstalledSession = EditorSnapshotSession & {
  readonly [METADATA_KEY]?: InstalledMetadata;
};

function isInstalledSession(value: unknown): value is EditorSnapshotSession {
  return isRecord(value) &&
    typeof value.capture === "function" &&
    typeof value.commit === "function";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function parseMessage(value: unknown): TypeBridgeMessage | null {
  if (
    !isRecord(value) ||
    value.target !== "sotto-type-bridge" ||
    (
      value.type !== "capture" &&
      value.type !== "commit" &&
      value.type !== "release"
    )
  ) {
    return null;
  }

  if (value.type === "release") {
    return (
      hasOnlyKeys(value, ["target", "type", "epochNonce"]) &&
      isEpochNonce(value.epochNonce)
    )
      ? {
          target: "sotto-type-bridge",
          type: "release",
          epochNonce: value.epochNonce,
        }
      : null;
  }

  if (value.type === "capture") {
    if (
      !hasOnlyKeys(value, [
        "target",
        "type",
        "options",
        "keepAlive",
        "epochNonce",
      ]) ||
      !isRecord(value.options) ||
      !hasOnlyKeys(value.options, ["requireSelection", "allowLastDictated"]) ||
      !isEpochNonce(value.epochNonce)
    ) {
      return null;
    }
    if (
      typeof value.options.requireSelection !== "boolean" ||
      typeof value.options.allowLastDictated !== "boolean" ||
      (value.keepAlive !== undefined &&
        typeof value.keepAlive !== "boolean")
    ) {
      return null;
    }
    return {
      target: "sotto-type-bridge",
      type: "capture",
      options: {
        requireSelection: value.options.requireSelection,
        allowLastDictated: value.options.allowLastDictated,
      },
      keepAlive: value.keepAlive === true,
      epochNonce: value.epochNonce,
    };
  }

  if (
    !hasOnlyKeys(value, [
      "target",
      "type",
      "snapshotId",
      "text",
      "inputType",
      "rememberAsDictation",
      "keepAlive",
      "epochNonce",
    ]) ||
    typeof value.snapshotId !== "string" ||
    value.snapshotId.length < 1 ||
    value.snapshotId.length > 128 ||
    typeof value.text !== "string" ||
    value.text.length > 24_000 ||
    (value.inputType !== "insertText" &&
      value.inputType !== "insertReplacementText") ||
    typeof value.rememberAsDictation !== "boolean" ||
    (value.keepAlive !== undefined &&
      typeof value.keepAlive !== "boolean") ||
    !isEpochNonce(value.epochNonce)
  ) {
    return null;
  }
  return {
    target: "sotto-type-bridge",
    type: "commit",
    snapshotId: value.snapshotId,
    text: value.text,
    inputType: value.inputType,
    rememberAsDictation: value.rememberAsDictation,
    keepAlive: value.keepAlive === true,
    epochNonce: value.epochNonce,
  };
}

function isEpochNonce(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 128
  );
}

function errorResponse(
  error: unknown,
  epoch: TypeBridgeEpoch,
): TypeBridgeResponse {
  return {
    ok: false,
    epoch,
    error: {
      code: error instanceof EditorGuardError ? error.code : "unexpected",
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

/**
 * Installs one listener in an isolated content-script world. It survives the
 * capture/model/commit round trip, then removes itself. Repeated injections
 * during a live operation reuse the first snapshot session.
 */
export function installTypeContentScriptBridge(
  options: TypeBridgeInstallOptions = {},
): EditorSnapshotSession {
  const scope = globalThis as typeof globalThis &
    Record<PropertyKey, unknown>;
  const bridgeDocument =
    options.document ??
    (typeof document === "undefined" ? undefined : document);
  const runtime =
    options.runtime ??
    (typeof chrome === "undefined" ? undefined : chrome.runtime);
  const bridgeWindow =
    options.window ??
    bridgeDocument?.defaultView ??
    (typeof window === "undefined" ? undefined : window);
  if (!bridgeDocument || !runtime) {
    throw new Error(
      "The type content-script bridge requires a document and chrome.runtime",
    );
  }

  const installed = scope[INSTALL_KEY];
  if (isInstalledSession(installed)) {
    const metadata = (installed as InstalledSession)[METADATA_KEY];
    if (
      !metadata ||
      !bridgeWindow ||
      metadata.href === bridgeWindow.location.href
    ) {
      return installed;
    }
    metadata.handleNavigation();
  }

  const session = new EditorSnapshotSession(bridgeDocument);
  const installedHref = bridgeWindow?.location.href ?? "";
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  let navigationTimer: ReturnType<typeof setInterval> | undefined;
  let cleaned = false;
  const cleanUp = (): void => {
    if (cleaned) return;
    cleaned = true;
    session.invalidate();
    runtime.onMessage.removeListener?.(listener);
    if (cleanupTimer !== undefined) clearTimeout(cleanupTimer);
    if (navigationTimer !== undefined) clearInterval(navigationTimer);
    bridgeWindow?.removeEventListener("popstate", navigationListener);
    bridgeWindow?.removeEventListener("hashchange", navigationListener);
    if (scope[INSTALL_KEY] === session) delete scope[INSTALL_KEY];
  };
  const notifyNavigation = (): void => {
    try {
      const pending = runtime.sendMessage?.({
        target: "worker",
        type: "type-bridge-navigation",
      });
      if (pending && typeof pending.then === "function") {
        void pending.catch(() => undefined);
      }
    } catch {
      // The worker can be unavailable during an extension update.
    }
  };
  const handleNavigation = (): void => {
    if (cleaned) return;
    notifyNavigation();
    cleanUp();
  };
  const checkForNavigation = (): boolean => {
    if (
      !bridgeWindow ||
      bridgeWindow.location.href === installedHref
    ) {
      return false;
    }
    handleNavigation();
    return true;
  };
  const navigationListener: EventListener = () => {
    checkForNavigation();
  };
  const scheduleCleanup = (): void => {
    if (!runtime.onMessage.removeListener) return;
    if (cleanupTimer !== undefined) clearTimeout(cleanupTimer);
    cleanupTimer = setTimeout(cleanUp, 5 * 60_000);
  };
  const listener = (
    raw: unknown,
    _sender: unknown,
    sendResponse: (response: TypeBridgeResponse) => void,
  ): void => {
    const message = parseMessage(raw);
    if (!message) return;
    const epoch = {
      href: installedHref,
      nonce: message.epochNonce,
    };
    if (checkForNavigation()) {
      sendResponse(
        errorResponse(
          new EditorGuardError(
            "stale-snapshot",
            "The page changed. Try again.",
          ),
          epoch,
        ),
      );
      return;
    }
    if (message.type === "release") {
      sendResponse({ ok: true, epoch, value: { released: true } });
      cleanUp();
      return;
    }
    let shouldCleanUp = message.type === "commit" && !message.keepAlive;
    try {
      const value =
        message.type === "capture"
          ? session.capture(message.options)
          : session.commit(
              message.snapshotId,
              message.text,
              message.inputType,
              message.rememberAsDictation,
            );
      sendResponse({ ok: true, epoch, value });
      if (message.type === "capture" || message.keepAlive) scheduleCleanup();
    } catch (error) {
      if (message.type === "capture" && !message.keepAlive) {
        shouldCleanUp = true;
      }
      sendResponse(errorResponse(error, epoch));
    } finally {
      if (shouldCleanUp) cleanUp();
    }
  };
  runtime.onMessage.addListener(listener);
  bridgeWindow?.addEventListener("popstate", navigationListener);
  bridgeWindow?.addEventListener("hashchange", navigationListener);
  if (bridgeWindow) {
    // Isolated worlds cannot observe page history method calls directly.
    // Poll the shared URL to detect pushState and replaceState.
    navigationTimer = setInterval(checkForNavigation, NAVIGATION_POLL_MS);
  }
  Object.defineProperty(session, METADATA_KEY, {
    configurable: true,
    value: { href: installedHref, handleNavigation } satisfies
      InstalledMetadata,
  });
  scope[INSTALL_KEY] = session;
  return session;
}
