import { describe, expect, it, vi } from "vitest";

import {
  EditorSnapshotSession,
  editableKind,
} from "../src/type/editor.js";

class FakeInputEvent {
  readonly type: string;
  readonly bubbles: boolean;
  readonly composed: boolean;
  readonly cancelable: boolean;
  readonly data: string | null;
  readonly inputType: string;

  constructor(
    type: string,
    init: {
      bubbles?: boolean;
      composed?: boolean;
      cancelable?: boolean;
      data?: string | null;
      inputType?: string;
    } = {},
  ) {
    this.type = type;
    this.bubbles = init.bubbles ?? false;
    this.composed = init.composed ?? false;
    this.cancelable = init.cancelable ?? false;
    this.data = init.data ?? null;
    this.inputType = init.inputType ?? "";
  }
}

interface FakeTextControl {
  localName: string;
  tagName: string;
  type: string;
  value: string;
  selectionStart: number;
  selectionEnd: number;
  disabled: boolean;
  readOnly: boolean;
  isConnected: boolean;
  ownerDocument: Document;
  parentElement: Element | null;
  shadowRoot: null;
  events: Array<{
    readonly type: string;
    readonly valueAtDispatch: string;
    readonly bubbles: boolean;
    readonly composed: boolean;
    readonly cancelable: boolean;
    readonly inputType: string;
  }>;
  cancelBeforeInput: boolean;
  getRootNode(): Document;
  hasAttribute(name: string): boolean;
  getAttribute(name: string): string | null;
  dispatchEvent(event: FakeInputEvent): boolean;
  setRangeText(
    text: string,
    start: number,
    end: number,
    mode: "end",
  ): void;
}

function textControl(
  values: Partial<
    Pick<
      FakeTextControl,
      | "localName"
      | "tagName"
      | "type"
      | "value"
      | "selectionStart"
      | "selectionEnd"
      | "disabled"
      | "readOnly"
      | "cancelBeforeInput"
    >
  > = {},
): {
  readonly document: Document;
  readonly control: FakeTextControl;
  readonly submit: ReturnType<typeof vi.fn>;
} {
  const submit = vi.fn();
  const fakeDocument = {
    activeElement: null,
    defaultView: {
      InputEvent: FakeInputEvent,
    },
    getSelection: () => null,
    body: { ownerDocument: null },
  } as unknown as Document;
  const control: FakeTextControl = {
    localName: values.localName ?? "input",
    tagName: values.tagName ?? "INPUT",
    type: values.type ?? "text",
    value: values.value ?? "",
    selectionStart: values.selectionStart ?? 0,
    selectionEnd: values.selectionEnd ?? 0,
    disabled: values.disabled ?? false,
    readOnly: values.readOnly ?? false,
    isConnected: true,
    ownerDocument: fakeDocument,
    parentElement: null,
    shadowRoot: null,
    events: [],
    cancelBeforeInput: values.cancelBeforeInput ?? false,
    getRootNode: () => fakeDocument,
    hasAttribute: () => false,
    getAttribute: () => null,
    dispatchEvent(event) {
      this.events.push({
        type: event.type,
        valueAtDispatch: this.value,
        bubbles: event.bubbles,
        composed: event.composed,
        cancelable: event.cancelable,
        inputType: event.inputType,
      });
      return !(event.type === "beforeinput" && this.cancelBeforeInput);
    },
    setRangeText(text, start, end) {
      this.value = this.value.slice(0, start) + text + this.value.slice(end);
      this.selectionStart = start + text.length;
      this.selectionEnd = start + text.length;
    },
  };
  (fakeDocument as unknown as { activeElement: FakeTextControl }).activeElement =
    control;
  return { document: fakeDocument, control, submit };
}

function asElement(control: FakeTextControl): Element {
  return control as unknown as Element;
}

describe("safe editable guards", () => {
  it.each(["text", "search", "url", "tel"])(
    "accepts an editable %s input",
    (type) => {
      const { control } = textControl({ type });
      expect(editableKind(asElement(control))).toBe("input");
    },
  );

  it.each([
    [{ type: "password" }, "password"],
    [{ type: "email" }, "email"],
    [{ type: "checkbox" }, "checkbox"],
    [{ type: "text", disabled: true }, "disabled"],
    [{ type: "text", readOnly: true }, "readonly"],
  ] as const)("refuses %s inputs", (values) => {
    const { control } = textControl(values);
    expect(editableKind(asElement(control))).toBeNull();
  });

  it("walks composed ancestors and refuses inert or aria-disabled editors", () => {
    for (const attribute of ["inert", "aria-disabled"] as const) {
      const { control } = textControl();
      const ancestor = {
        parentElement: null,
        getRootNode: () => control.ownerDocument,
        hasAttribute: (name: string) => name === attribute,
        getAttribute: (name: string) =>
          attribute === "aria-disabled" && name === attribute ? "true" : null,
      } as unknown as Element;
      control.parentElement = ancestor;
      expect(editableKind(asElement(control))).toBeNull();
    }
  });
});

describe("text-control commits", () => {
  it("dispatches cancelable beforeinput, uses setRangeText, then bubbles input", () => {
    const { document, control, submit } = textControl({
      value: "hello world",
      selectionStart: 6,
      selectionEnd: 11,
    });
    const session = new EditorSnapshotSession(document);
    const capture = session.capture({
      requireSelection: false,
      allowLastDictated: false,
    });

    expect(capture).toMatchObject({
      selectedText: "world",
      source: "selection",
    });
    expect(
      session.commit(
        capture.snapshotId,
        "there",
        "insertReplacementText",
      ),
    ).toEqual({ kind: "input" });
    expect(control.value).toBe("hello there");
    expect(control.events).toEqual([
      {
        type: "beforeinput",
        valueAtDispatch: "hello world",
        bubbles: true,
        composed: true,
        cancelable: true,
        inputType: "insertReplacementText",
      },
      {
        type: "input",
        valueAtDispatch: "hello there",
        bubbles: true,
        composed: true,
        cancelable: false,
        inputType: "insertReplacementText",
      },
    ]);
    expect(submit).not.toHaveBeenCalled();
  });

  it("fails closed if beforeinput is cancelled", () => {
    const { document, control } = textControl({
      value: "hello",
      selectionStart: 5,
      selectionEnd: 5,
      cancelBeforeInput: true,
    });
    const session = new EditorSnapshotSession(document);
    const capture = session.capture({
      requireSelection: false,
      allowLastDictated: false,
    });

    expect(() =>
      session.commit(capture.snapshotId, "!", "insertText"),
    ).toThrow("declined");
    expect(control.value).toBe("hello");
    expect(control.events).toHaveLength(1);
  });

  it("rejects a focus or selection change after capture", () => {
    const { document, control } = textControl({
      value: "hello",
      selectionStart: 5,
      selectionEnd: 5,
    });
    const session = new EditorSnapshotSession(document);
    const capture = session.capture({
      requireSelection: false,
      allowLastDictated: false,
    });
    control.selectionStart = 0;
    control.selectionEnd = 0;

    expect(() =>
      session.commit(capture.snapshotId, "!", "insertText"),
    ).toThrow("selection changed");
    expect(control.value).toBe("hello");
    expect(control.events).toHaveLength(0);
  });

  it("can rewrite the last dictated input range while the caret stays put", () => {
    const { document, control } = textControl();
    const session = new EditorSnapshotSession(document);
    const dictate = session.capture({
      requireSelection: false,
      allowLastDictated: false,
    });
    session.commit(dictate.snapshotId, "thanks", "insertText");

    const rewrite = session.capture({
      requireSelection: true,
      allowLastDictated: true,
    });
    expect(rewrite).toMatchObject({
      selectedText: "thanks",
      source: "last-dictated",
    });
    session.commit(
      rewrite.snapshotId,
      "Thank you.",
      "insertReplacementText",
    );
    expect(control.value).toBe("Thank you.");
  });
});
