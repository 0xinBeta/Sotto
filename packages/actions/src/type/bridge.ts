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
    }
  | {
      readonly target: "sotto-type-bridge";
      readonly type: "commit";
      readonly snapshotId: string;
      readonly text: string;
      readonly inputType: "insertText" | "insertReplacementText";
    };

export type TypeBridgeResponse =
  | {
      readonly ok: true;
      readonly value: EditorCapture | EditorCommit;
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

function parseMessage(value: unknown): TypeBridgeMessage | null {
  if (
    !isRecord(value) ||
    value.target !== "sotto-type-bridge" ||
    (value.type !== "capture" && value.type !== "commit")
  ) {
    return null;
  }

  if (value.type === "capture") {
    if (!isRecord(value.options)) return null;
    if (
      typeof value.options.requireSelection !== "boolean" ||
      typeof value.options.allowLastDictated !== "boolean"
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
    };
  }

  if (
    typeof value.snapshotId !== "string" ||
    typeof value.text !== "string" ||
    (value.inputType !== "insertText" &&
      value.inputType !== "insertReplacementText")
  ) {
    return null;
  }
  return {
    target: "sotto-type-bridge",
    type: "commit",
    snapshotId: value.snapshotId,
    text: value.text,
    inputType: value.inputType,
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
 * Installs one long-lived listener in an isolated content-script world.
 * Repeated imports/calls in the same world reuse the first snapshot session.
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
  runtime.onMessage.addListener((raw, _sender, sendResponse) => {
    const message = parseMessage(raw);
    if (!message) return;
    try {
      const value =
        message.type === "capture"
          ? session.capture(message.options)
          : session.commit(
              message.snapshotId,
              message.text,
              message.inputType,
            );
      sendResponse({ ok: true, value });
    } catch (error) {
      sendResponse(errorResponse(error));
    }
  });
  scope[INSTALL_KEY] = session;
  return session;
}
