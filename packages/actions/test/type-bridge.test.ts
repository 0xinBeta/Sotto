import { afterEach, describe, expect, it, vi } from "vitest";

import { installTypeContentScriptBridge } from "../src/type/bridge.js";

const installKey = Symbol.for("sotto.type-content-script-bridge.v0.2");

afterEach(() => {
  delete (globalThis as Record<PropertyKey, unknown>)[installKey];
});

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
});
