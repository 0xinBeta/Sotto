import { afterEach, describe, expect, it, vi } from "vitest";

import { installTypeContentScriptBridge } from "../src/type/bridge.js";
import { EditorSnapshotSession } from "../src/type/editor.js";

const installKey = Symbol.for("sotto.type-content-script-bridge.v0.2");

afterEach(() => {
  delete (globalThis as Record<PropertyKey, unknown>)[installKey];
  vi.useRealTimers();
  vi.restoreAllMocks();
});

class HistoryWindow extends EventTarget {
  readonly location = { href: "https://example.test/one" };

  readonly history = {
    pushState: (_data: unknown, _unused: string, url: string): void => {
      this.location.href = new URL(url, this.location.href).href;
    },
    replaceState: (_data: unknown, _unused: string, url: string): void => {
      this.location.href = new URL(url, this.location.href).href;
    },
  };
}

describe("type content-script bridge", () => {
  it("installs one listener idempotently", () => {
    const addListener = vi.fn();
    const runtime = { onMessage: { addListener } };
    const document = {} as Document;

    const first = installTypeContentScriptBridge({ runtime, document });
    const second = installTypeContentScriptBridge({ runtime, document });

    expect(second).toBe(first);
    expect(addListener).toHaveBeenCalledTimes(1);
  });

  it("reuses a structurally valid session from an earlier bundle evaluation", () => {
    const addListener = vi.fn();
    const previousBundleSession = {
      capture: vi.fn(),
      commit: vi.fn(),
    };
    (globalThis as Record<PropertyKey, unknown>)[installKey] =
      previousBundleSession;

    const installed = installTypeContentScriptBridge({
      runtime: { onMessage: { addListener } },
      document: {} as Document,
    });

    expect(installed).toBe(previousBundleSession);
    expect(addListener).not.toHaveBeenCalled();
  });

  it("ignores unrelated messages without responding", () => {
    let listener:
      | ((
          message: unknown,
          sender: unknown,
          respond: (response: unknown) => void,
        ) => boolean | void)
      | undefined;
    const runtime = {
      onMessage: {
        addListener: vi.fn((registered: typeof listener) => {
          listener = registered;
        }),
      },
    };
    installTypeContentScriptBridge({
      runtime,
      document: {} as Document,
    });
    const respond = vi.fn();

    expect(listener?.({ target: "sidepanel" }, {}, respond)).toBeUndefined();
    expect(respond).not.toHaveBeenCalled();
  });

  it("rejects an oversized or incompletely validated commit message", () => {
    let listener:
      | ((
          message: unknown,
          sender: unknown,
          respond: (response: unknown) => void,
        ) => boolean | void)
      | undefined;
    installTypeContentScriptBridge({
      runtime: {
        onMessage: {
          addListener: vi.fn((registered: typeof listener) => {
            listener = registered;
          }),
        },
      },
      document: {} as Document,
    });
    const respond = vi.fn();

    listener?.(
      {
        target: "sotto-type-bridge",
        type: "commit",
        snapshotId: "editor-1",
        text: "x".repeat(24_001),
        inputType: "insertText",
        rememberAsDictation: true,
        epochNonce: "commit-one",
      },
      {},
      respond,
    );
    listener?.(
      {
        target: "sotto-type-bridge",
        type: "commit",
        snapshotId: "editor-1",
        text: "safe",
        inputType: "insertText",
        epochNonce: "commit-two",
      },
      {},
      respond,
    );

    expect(respond).not.toHaveBeenCalled();
  });

  it("removes a failed capture listener so the injected bridge does not linger", () => {
    let listener:
      | ((
          message: unknown,
          sender: unknown,
          respond: (response: unknown) => void,
        ) => boolean | void)
      | undefined;
    const removeListener = vi.fn();
    installTypeContentScriptBridge({
      runtime: {
        onMessage: {
          addListener: vi.fn((registered: typeof listener) => {
            listener = registered;
          }),
          removeListener,
        },
      },
      document: {
        hasFocus: () => true,
        activeElement: null,
      } as unknown as Document,
    });

    listener?.(
      {
        target: "sotto-type-bridge",
        type: "capture",
        options: {
          requireSelection: false,
          allowLastDictated: false,
        },
        epochNonce: "capture-one",
      },
      {},
      vi.fn(),
    );

    expect(removeListener).toHaveBeenCalledWith(listener);
    expect(
      (globalThis as Record<PropertyKey, unknown>)[installKey],
    ).toBeUndefined();
  });

  it("detects pushState by polling and pauses the active bridge", () => {
    vi.useFakeTimers();
    const navigation = new HistoryWindow();
    const removeListener = vi.fn();
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    installTypeContentScriptBridge({
      runtime: {
        sendMessage,
        onMessage: {
          addListener: vi.fn(),
          removeListener,
        },
      },
      document: {} as Document,
      window: navigation,
    });

    navigation.history.pushState({}, "", "/two");
    vi.advanceTimersByTime(250);

    expect(sendMessage).toHaveBeenCalledWith({
      target: "worker",
      type: "type-bridge-navigation",
    });
    expect(removeListener).toHaveBeenCalledOnce();
    expect(
      (globalThis as Record<PropertyKey, unknown>)[installKey],
    ).toBeUndefined();
  });

  it("re-arms once across navigation and injection interleavings", () => {
    vi.useFakeTimers();
    const navigation = new HistoryWindow();
    const listeners: unknown[] = [];
    const removeListener = vi.fn();
    const runtime = {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      onMessage: {
        addListener: vi.fn((listener: unknown) => {
          listeners.push(listener);
        }),
        removeListener,
      },
    };
    const options = {
      runtime,
      document: {} as Document,
      window: navigation,
    };

    const first = installTypeContentScriptBridge(options);
    expect(installTypeContentScriptBridge(options)).toBe(first);
    navigation.history.pushState({}, "", "/two");
    const second = installTypeContentScriptBridge(options);
    expect(installTypeContentScriptBridge(options)).toBe(second);

    expect(second).not.toBe(first);
    expect(runtime.onMessage.addListener).toHaveBeenCalledTimes(2);
    expect(removeListener).toHaveBeenCalledWith(listeners[0]);

    navigation.history.replaceState({}, "", "/three");
    vi.advanceTimersByTime(250);
    expect(removeListener).toHaveBeenCalledWith(listeners[1]);
  });

  it("does not commit a captured range after pushState", () => {
    vi.useFakeTimers();
    const navigation = new HistoryWindow();
    let listener:
      | ((
          message: unknown,
          sender: unknown,
          respond: (response: unknown) => void,
        ) => void)
      | undefined;
    vi.spyOn(EditorSnapshotSession.prototype, "capture").mockReturnValue({
      snapshotId: "editor-1",
      targetId: "field-1",
      selectedText: "",
      source: "caret",
    });
    const commit = vi
      .spyOn(EditorSnapshotSession.prototype, "commit")
      .mockReturnValue({ kind: "textarea" });
    installTypeContentScriptBridge({
      runtime: {
        sendMessage: vi.fn().mockResolvedValue(undefined),
        onMessage: {
          addListener: vi.fn((registered: typeof listener) => {
            listener = registered;
          }),
          removeListener: vi.fn(),
        },
      },
      document: {} as Document,
      window: navigation,
    });
    const captureResponse = vi.fn();
    listener?.(
      {
        target: "sotto-type-bridge",
        type: "capture",
        options: {
          requireSelection: false,
          allowLastDictated: false,
        },
        keepAlive: true,
        epochNonce: "capture-one",
      },
      {},
      captureResponse,
    );

    navigation.history.pushState({}, "", "/two");
    const commitResponse = vi.fn();
    listener?.(
      {
        target: "sotto-type-bridge",
        type: "commit",
        snapshotId: "editor-1",
        text: "stale text",
        inputType: "insertText",
        rememberAsDictation: true,
        keepAlive: true,
        epochNonce: "commit-one",
      },
      {},
      commitResponse,
    );

    expect(captureResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        epoch: {
          href: "https://example.test/one",
          nonce: "capture-one",
        },
      }),
    );
    expect(commit).not.toHaveBeenCalled();
    expect(commitResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          message: "The page changed. Try again.",
        }),
      }),
    );
  });
});
