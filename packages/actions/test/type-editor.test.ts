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
  onBeforeInput?: () => void;
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
    onBeforeInput: undefined,
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
      if (event.type === "beforeinput") this.onBeforeInput?.();
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

class FakeRange {
  startContainer: Node;
  endContainer: Node;

  constructor(
    readonly target: FakeContentEditable,
    public startOffset: number,
    public endOffset: number,
  ) {
    this.startContainer = target as unknown as Node;
    this.endContainer = target as unknown as Node;
  }

  cloneRange(): Range {
    const clone = new FakeRange(
      this.target,
      this.startOffset,
      this.endOffset,
    );
    clone.startContainer = this.startContainer;
    clone.endContainer = this.endContainer;
    return clone as unknown as Range;
  }

  private globalOffset(container: Node, offset: number): number {
    if (container === (this.target as unknown as Node)) return offset;
    return (
      (container as unknown as { start?: number }).start ?? 0
    ) + offset;
  }

  selectNodeContents(node: Node = this.target as unknown as Node): void {
    this.startContainer = node;
    this.endContainer = node;
    this.startOffset = 0;
    this.endOffset =
      node === (this.target as unknown as Node)
        ? this.target.textContent.length
        : (node as unknown as { data?: string }).data?.length ?? 0;
  }

  setStart(node: Node, offset: number): void {
    this.startContainer = node;
    this.startOffset = offset;
  }

  setEnd(node: Node, offset: number): void {
    this.endContainer = node;
    this.endOffset = offset;
  }

  toString(): string {
    return this.target.textContent.slice(
      this.globalOffset(this.startContainer, this.startOffset),
      this.globalOffset(this.endContainer, this.endOffset),
    );
  }

  deleteContents(): void {
    const start = this.globalOffset(this.startContainer, this.startOffset);
    const end = this.globalOffset(this.endContainer, this.endOffset);
    this.target.textContent =
      this.target.textContent.slice(0, start) +
      this.target.textContent.slice(end);
    if (this.startContainer !== (this.target as unknown as Node)) {
      const node = this.startContainer as unknown as {
        data?: string;
        end?: number;
      };
      node.data = "";
      node.end = start;
    }
    this.startContainer = this.target as unknown as Node;
    this.endContainer = this.target as unknown as Node;
    this.startOffset = start;
    this.endOffset = start;
  }

  insertNode(node: Node): void {
    const start = this.globalOffset(this.startContainer, this.startOffset);
    const inserted = node as unknown as {
      data: string;
      start?: number;
      end?: number;
      target?: FakeContentEditable;
    };
    this.target.textContent =
      this.target.textContent.slice(0, start) +
      inserted.data +
      this.target.textContent.slice(start);
    inserted.start = start;
    inserted.end = start + inserted.data.length;
    inserted.target = this.target;
  }

  setStartAfter(node: Node): void {
    this.startContainer = this.target as unknown as Node;
    this.startOffset =
      (node as unknown as { end?: number }).end ?? this.startOffset;
  }

  collapse(): void {
    this.endContainer = this.startContainer;
    this.endOffset = this.startOffset;
  }
}

interface FakeContentEditable {
  readonly localName: "div";
  readonly tagName: "DIV";
  readonly isContentEditable: true;
  readonly isConnected: true;
  readonly parentElement: null;
  readonly shadowRoot: null;
  readonly ownerDocument: Document;
  textContent: string;
  onBeforeInput?: () => void;
  events: string[];
  getRootNode(): Document;
  hasAttribute(name: string): boolean;
  getAttribute(name: string): string | null;
  contains(node: Node): boolean;
  matches(selector: string): boolean;
  querySelector(selector: string): Element | null;
  querySelectorAll(selector: string): Element[];
  dispatchEvent(event: FakeInputEvent): boolean;
}

function contentEditable(
  text: string,
  start: number,
  end: number,
): {
  readonly document: Document;
  readonly target: FakeContentEditable;
  readonly selection: {
    range: FakeRange;
  };
  readonly execCommand: ReturnType<typeof vi.fn>;
} {
  const selection = {
    range: undefined as unknown as FakeRange,
  };
  const execCommand = vi.fn();
  let target: FakeContentEditable;
  const fakeDocument = {
    activeElement: null,
    defaultView: { InputEvent: FakeInputEvent },
    execCommand,
    getSelection: () => ({
      rangeCount: 1,
      getRangeAt: () => selection.range as unknown as Range,
      removeAllRanges: vi.fn(),
      addRange: (range: Range) => {
        selection.range = range as unknown as FakeRange;
      },
    }),
    createTextNode: (data: string) => ({ data }) as unknown as Text,
    createRange: () => new FakeRange(
      target,
      0,
      0,
    ) as unknown as Range,
  } as unknown as Document;
  target = {
    localName: "div",
    tagName: "DIV",
    isContentEditable: true,
    isConnected: true,
    parentElement: null,
    shadowRoot: null,
    ownerDocument: fakeDocument,
    textContent: text,
    events: [],
    getRootNode: () => fakeDocument,
    hasAttribute: () => false,
    getAttribute: (name) =>
      name === "contenteditable" ? "plaintext-only" : null,
    contains: (node) =>
      node === (target as unknown as Node) ||
      (node as unknown as { target?: FakeContentEditable }).target === target,
    matches: () => false,
    querySelector: () => null,
    querySelectorAll: () => [],
    dispatchEvent(event) {
      this.events.push(event.type);
      if (event.type === "beforeinput") this.onBeforeInput?.();
      return true;
    },
  };
  (fakeDocument as unknown as { activeElement: FakeContentEditable }).activeElement =
    target;
  selection.range = new FakeRange(target, start, end);
  return { document: fakeDocument, target, selection, execCommand };
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

  it("refuses capture when focus is on a non-editable element", () => {
    const element = {
      localName: "button",
      tagName: "BUTTON",
      parentElement: null,
      shadowRoot: null,
      getRootNode: () => document,
      hasAttribute: () => false,
      getAttribute: () => null,
    } as unknown as Element;
    const document = {
      activeElement: element,
    } as unknown as Document;

    expect(() =>
      new EditorSnapshotSession(document).capture({
        requireSelection: false,
        allowLastDictated: false,
      }),
    ).toThrow("safe, editable text field");
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

  it("inserts dictation line breaks as text and never submits", () => {
    const { document, control, submit } = textControl({
      value: "FirstSecond",
      selectionStart: 5,
      selectionEnd: 5,
    });
    const session = new EditorSnapshotSession(document);
    const capture = session.capture({
      requireSelection: false,
      allowLastDictated: false,
    });

    session.commit(capture.snapshotId, "\n\n", "insertText", true);

    expect(control.value).toBe("First\n\nSecond");
    expect(control.events.map((event) => event.type)).toEqual([
      "beforeinput",
      "input",
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

  it.each(["disabled", "readOnly"] as const)(
    "rejects a control that becomes %s after capture",
    (property) => {
      const { document, control } = textControl({
        value: "selected",
        selectionStart: 0,
        selectionEnd: 8,
      });
      const session = new EditorSnapshotSession(document);
      const capture = session.capture({
        requireSelection: true,
        allowLastDictated: false,
      });
      control[property] = true;

      expect(() =>
        session.commit(capture.snapshotId, "replacement", "insertReplacementText"),
      ).toThrow("focused editor changed");
      expect(control.value).toBe("selected");
      expect(control.events).toHaveLength(0);
    },
  );

  it("rejects commit after the captured document loses focus", () => {
    const { document, control } = textControl({
      value: "hello",
      selectionStart: 5,
      selectionEnd: 5,
    });
    const hasFocus = vi.fn().mockReturnValue(true);
    (document as unknown as { hasFocus: () => boolean }).hasFocus = hasFocus;
    const session = new EditorSnapshotSession(document);
    const capture = session.capture({
      requireSelection: false,
      allowLastDictated: false,
    });
    hasFocus.mockReturnValue(false);

    expect(() =>
      session.commit(capture.snapshotId, "!", "insertText"),
    ).toThrow("focused editor changed");
    expect(control.value).toBe("hello");
    expect(control.events).toHaveLength(0);
  });

  it.each(["disabled", "readOnly"] as const)(
    "rejects when beforeinput makes the control %s",
    (property) => {
      const { document, control } = textControl({
        value: "hello",
        selectionStart: 5,
        selectionEnd: 5,
      });
      control.onBeforeInput = () => {
        control[property] = true;
      };
      const session = new EditorSnapshotSession(document);
      const capture = session.capture({
        requireSelection: false,
        allowLastDictated: false,
      });

      expect(() =>
        session.commit(capture.snapshotId, "!", "insertText"),
      ).toThrow("focused editor changed");
      expect(control.value).toBe("hello");
      expect(control.events.map((event) => event.type)).toEqual(["beforeinput"]);
    },
  );

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

  it("remembers dictation that replaced a prior selection", () => {
    const { document, control } = textControl({
      value: "replace me",
      selectionStart: 0,
      selectionEnd: 10,
    });
    const session = new EditorSnapshotSession(document);
    const dictate = session.capture({
      requireSelection: false,
      allowLastDictated: false,
    });
    session.commit(
      dictate.snapshotId,
      "thanks",
      "insertReplacementText",
      true,
    );

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
      false,
    );
    expect(control.value).toBe("Thank you.");
  });
});

describe("contenteditable exact-range commits", () => {
  it("takes the contenteditable branch and changes only the captured range", () => {
    const harness = contentEditable("prefix selected suffix", 7, 15);
    const session = new EditorSnapshotSession(harness.document);
    const capture = session.capture({
      requireSelection: true,
      allowLastDictated: false,
    });

    expect(capture).toMatchObject({
      selectedText: "selected",
      source: "selection",
    });
    expect(
      session.commit(
        capture.snapshotId,
        "rewritten",
        "insertReplacementText",
      ),
    ).toEqual({ kind: "contenteditable" });
    expect(harness.target.textContent).toBe("prefix rewritten suffix");
    expect(harness.target.events).toEqual(["beforeinput", "input"]);
    expect(harness.execCommand).not.toHaveBeenCalled();
  });

  it("does not insert if beforeinput moves selection outside the captured range", () => {
    const harness = contentEditable("first target second target", 6, 12);
    harness.target.onBeforeInput = () => {
      harness.selection.range = new FakeRange(harness.target, 20, 26);
    };
    const session = new EditorSnapshotSession(harness.document);
    const capture = session.capture({
      requireSelection: true,
      allowLastDictated: false,
    });

    expect(() =>
      session.commit(
        capture.snapshotId,
        "MODEL_OUTPUT",
        "insertReplacementText",
      ),
    ).toThrow("selection changed");
    expect(harness.target.textContent).toBe("first target second target");
    expect(harness.target.textContent).not.toContain("MODEL_OUTPUT");
    expect(harness.target.events).toEqual(["beforeinput"]);
  });

  it("can rewrite the last dictated contenteditable range", () => {
    const harness = contentEditable("prefix suffix", 7, 7);
    const session = new EditorSnapshotSession(harness.document);
    const dictate = session.capture({
      requireSelection: false,
      allowLastDictated: false,
    });
    session.commit(dictate.snapshotId, "thanks", "insertText", true);

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
      false,
    );
    expect(harness.target.textContent).toBe("prefix Thank you.suffix");
  });

  it("uses verified native insertion for ordinary rich contenteditable", () => {
    const harness = contentEditable("prefix selected suffix", 7, 15);
    harness.target.getAttribute = (name) =>
      name === "contenteditable" ? "true" : null;
    harness.target.querySelectorAll = () => [
      { localName: "span", tagName: "SPAN" } as Element,
    ];
    harness.execCommand.mockImplementation(
      (_command: string, _showUi: boolean, value: string) => {
        const range = harness.selection.range;
        range.deleteContents();
        const inserted = { data: value } as unknown as Node;
        range.insertNode(inserted);
        range.setStartAfter(inserted);
        range.collapse();
        return true;
      },
    );
    const session = new EditorSnapshotSession(harness.document);
    const capture = session.capture({
      requireSelection: true,
      allowLastDictated: false,
    });

    expect(
      session.commit(
        capture.snapshotId,
        "rewritten",
        "insertReplacementText",
        false,
      ),
    ).toEqual({ kind: "contenteditable" });
    expect(harness.target.textContent).toBe("prefix rewritten suffix");
    expect(harness.execCommand).toHaveBeenCalledWith(
      "insertText",
      false,
      "rewritten",
    );
  });
});
