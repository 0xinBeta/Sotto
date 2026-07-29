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
    }
  | {
      readonly target: "sotto-type-bridge";
      readonly type: "commit";
      readonly snapshotId: string;
      readonly text: string;
      readonly inputType: "insertText" | "insertReplacementText";
      readonly rememberAsDictation: boolean;
      readonly keepAlive: boolean;
    }
  | {
      readonly target: "sotto-type-bridge";
      readonly type: "release";
    };

export type TypeBridgeResponse =
  | {
      readonly ok: true;
      readonly value: EditorCapture | EditorCommit | { readonly released: true };
    }
  | {
      readonly ok: false;
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
}

export interface TypeBridgeInstallOptions {
  readonly document?: Document;
  readonly runtime?: RuntimeLike;
}

const INSTALL_KEY = Symbol.for("sotto.type-content-script-bridge.v0.2");

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
    return hasOnlyKeys(value, ["target", "type"])
      ? { target: "sotto-type-bridge", type: "release" }
      : null;
  }

  if (value.type === "capture") {
    if (
      !hasOnlyKeys(value, ["target", "type", "options", "keepAlive"]) ||
      !isRecord(value.options) ||
      !hasOnlyKeys(value.options, ["requireSelection", "allowLastDictated"])
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
      typeof value.keepAlive !== "boolean")
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
  };
}

function errorResponse(error: unknown): TypeBridgeResponse {
  return {
    ok: false,
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
  const installed = scope[INSTALL_KEY];
  if (isInstalledSession(installed)) return installed;

  const bridgeDocument =
    options.document ??
    (typeof document === "undefined" ? undefined : document);
  const runtime =
    options.runtime ??
    (typeof chrome === "undefined" ? undefined : chrome.runtime);
  if (!bridgeDocument || !runtime) {
    throw new Error(
      "The type content-script bridge requires a document and chrome.runtime",
    );
  }

  const session = new EditorSnapshotSession(bridgeDocument);
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  const cleanUp = (): void => {
    if (!runtime.onMessage.removeListener) return;
    runtime.onMessage.removeListener(listener);
    if (cleanupTimer !== undefined) clearTimeout(cleanupTimer);
    if (scope[INSTALL_KEY] === session) delete scope[INSTALL_KEY];
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
    if (message.type === "release") {
      sendResponse({ ok: true, value: { released: true } });
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
      sendResponse({ ok: true, value });
      if (message.type === "capture" || message.keepAlive) scheduleCleanup();
    } catch (error) {
      if (message.type === "capture" && !message.keepAlive) {
        shouldCleanUp = true;
      }
      sendResponse(errorResponse(error));
    } finally {
      if (shouldCleanUp) cleanUp();
    }
  };
  runtime.onMessage.addListener(listener);
  scope[INSTALL_KEY] = session;
  return session;
}
