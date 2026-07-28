import type {
  EditorCapture,
  EditorCaptureOptions,
  EditorCommit,
} from "./types.js";

export type EditableKind = "input" | "textarea" | "contenteditable";

type TextControl = HTMLInputElement | HTMLTextAreaElement;

interface TextControlSnapshot {
  readonly kind: "input" | "textarea";
  readonly target: TextControl;
  readonly document: Document;
  readonly expectedSelectionStart: number;
  readonly expectedSelectionEnd: number;
  readonly replacementStart: number;
  readonly replacementEnd: number;
  readonly selectedText: string;
}

interface ContentEditableSnapshot {
  readonly kind: "contenteditable";
  readonly target: HTMLElement;
  readonly document: Document;
  readonly range: Range;
  readonly selectedText: string;
}

type Snapshot = TextControlSnapshot | ContentEditableSnapshot;

interface LastDictatedTextRange {
  readonly target: TextControl;
  readonly document: Document;
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

const SAFE_INPUT_TYPES = new Set(["text", "search", "url", "tel"]);

export class EditorGuardError extends Error {
  constructor(
    readonly code:
      | "no-editor"
      | "unsafe-editor"
      | "selection-required"
      | "stale-snapshot"
      | "beforeinput-cancelled"
      | "complex-editor"
      | "commit-failed",
    message: string,
  ) {
    super(message);
    this.name = "EditorGuardError";
  }
}

function elementName(element: Element): string {
  return (element.localName || element.tagName || "").toLocaleLowerCase(
    "en-US",
  );
}

function shadowHost(element: Element): Element | null {
  const root = element.getRootNode?.();
  if (
    root &&
    typeof root === "object" &&
    "host" in root &&
    (root as { host?: unknown }).host
  ) {
    return (root as { host: Element }).host;
  }
  return null;
}

function isBlockedByComposedAncestor(element: Element): boolean {
  let current: Element | null = element;
  const visited = new Set<Element>();
  while (current && !visited.has(current)) {
    visited.add(current);
    if (
      current.hasAttribute?.("inert") ||
      current.getAttribute?.("aria-disabled")?.trim().toLowerCase() === "true"
    ) {
      return true;
    }
    current = current.parentElement ?? shadowHost(current);
  }
  return false;
}

export function editableKind(element: Element | null): EditableKind | null {
  if (!element || isBlockedByComposedAncestor(element)) return null;

  const name = elementName(element);
  if (name === "input") {
    const input = element as HTMLInputElement;
    const type = (input.type || "text").toLocaleLowerCase("en-US");
    return !input.disabled && !input.readOnly && SAFE_INPUT_TYPES.has(type)
      ? "input"
      : null;
  }
  if (name === "textarea") {
    const textarea = element as HTMLTextAreaElement;
    return !textarea.disabled && !textarea.readOnly ? "textarea" : null;
  }
  if ((element as HTMLElement).isContentEditable === true) {
    return "contenteditable";
  }
  return null;
}

export function isSafeEditable(element: Element | null): boolean {
  return editableKind(element) !== null;
}

export function deepActiveElement(
  root: Document | ShadowRoot = document,
): Element | null {
  let active = root.activeElement;
  const visited = new Set<Element>();
  while (active && !visited.has(active)) {
    visited.add(active);
    const shadowActive = (active as HTMLElement).shadowRoot?.activeElement;
    if (!shadowActive) break;
    active = shadowActive;
  }
  return active;
}

function nodeIsInside(target: Element, node: Node): boolean {
  return node === target || target.contains(node);
}

function selectedRange(
  document: Document,
  target: HTMLElement,
): Range | null {
  const selection = document.getSelection();
  if (!selection || selection.rangeCount !== 1) return null;
  const range = selection.getRangeAt(0);
  if (
    !nodeIsInside(target, range.startContainer) ||
    !nodeIsInside(target, range.endContainer)
  ) {
    return null;
  }
  return range;
}

function rangesMatch(left: Range, right: Range): boolean {
  return (
    left.startContainer === right.startContainer &&
    left.startOffset === right.startOffset &&
    left.endContainer === right.endContainer &&
    left.endOffset === right.endOffset
  );
}

function inputEvent(
  document: Document,
  type: "beforeinput" | "input",
  text: string,
  inputType: "insertText" | "insertReplacementText",
): Event {
  const view = document.defaultView;
  const InputEventConstructor =
    view?.InputEvent ??
    (typeof InputEvent === "undefined" ? undefined : InputEvent);
  if (InputEventConstructor) {
    return new InputEventConstructor(type, {
      bubbles: true,
      composed: true,
      cancelable: type === "beforeinput",
      data: text,
      inputType,
    });
  }

  const EventConstructor =
    view?.Event ?? (typeof Event === "undefined" ? undefined : Event);
  if (!EventConstructor) {
    throw new EditorGuardError(
      "commit-failed",
      "This page cannot create editor input events",
    );
  }
  const event = new EventConstructor(type, {
    bubbles: true,
    composed: true,
    cancelable: type === "beforeinput",
  });
  Object.defineProperties(event, {
    data: { configurable: true, value: text },
    inputType: { configurable: true, value: inputType },
  });
  return event;
}

function isConnectedToDocument(target: Element, document: Document): boolean {
  return target.ownerDocument === document && target.isConnected;
}

function textOffset(target: HTMLElement, range: Range): number | null {
  try {
    const prefix = range.cloneRange();
    prefix.selectNodeContents(target);
    prefix.setEnd(range.startContainer, range.startOffset);
    return prefix.toString().length;
  } catch {
    return null;
  }
}

function isSimpleContentEditable(target: HTMLElement): boolean {
  const explicitlyPlain =
    target.getAttribute("contenteditable")?.toLowerCase() === "plaintext-only";
  const complexMarker =
    target.matches(
      '[data-lexical-editor], [data-slate-editor], .ProseMirror, [role="application"]',
    ) ||
    target.querySelector(
      '[data-lexical-editor], [data-slate-editor], .ProseMirror, [role="application"]',
    ) !== null;
  if (complexMarker) return false;
  if (explicitlyPlain) return true;
  return Array.from(target.querySelectorAll("*")).every(
    (element) => elementName(element) === "br",
  );
}

function assertCurrentTarget(snapshot: Snapshot): void {
  if (
    !isConnectedToDocument(snapshot.target, snapshot.document) ||
    deepActiveElement(snapshot.document) !== snapshot.target ||
    editableKind(snapshot.target) !== snapshot.kind
  ) {
    throw new EditorGuardError(
      "stale-snapshot",
      "The focused editor changed before Sotto could type",
    );
  }
}

export class EditorSnapshotSession {
  readonly #snapshots = new Map<string, Snapshot>();
  #lastDictated: LastDictatedTextRange | undefined;
  #sequence = 0;

  constructor(readonly document: Document) {}

  capture(options: EditorCaptureOptions): EditorCapture {
    if (
      typeof this.document.hasFocus === "function" &&
      !this.document.hasFocus()
    ) {
      throw new EditorGuardError(
        "no-editor",
        "The editor is not in the focused frame",
      );
    }
    const target = deepActiveElement(this.document);
    if (!target) {
      throw new EditorGuardError(
        "no-editor",
        "Focus a text field before asking Sotto to type",
      );
    }

    const kind = editableKind(target);
    if (!kind) {
      throw new EditorGuardError(
        "unsafe-editor",
        "Sotto will only type into a safe, editable text field",
      );
    }

    const snapshotId = `editor-${++this.#sequence}`;
    let snapshot: Snapshot;
    let source: EditorCapture["source"];

    if (kind === "input" || kind === "textarea") {
      const control = target as TextControl;
      const selectionStart = control.selectionStart;
      const selectionEnd = control.selectionEnd;
      if (
        typeof selectionStart !== "number" ||
        typeof selectionEnd !== "number"
      ) {
        throw new EditorGuardError(
          "unsafe-editor",
          "This text field does not expose a safe selection",
        );
      }

      let replacementStart = selectionStart;
      let replacementEnd = selectionEnd;
      let selectedText = control.value.slice(selectionStart, selectionEnd);
      source = selectedText ? "selection" : "caret";

      const last = this.#lastDictated;
      if (
        options.requireSelection &&
        !selectedText &&
        options.allowLastDictated &&
        last?.target === control &&
        last.document === this.document &&
        selectionStart === selectionEnd &&
        selectionStart === last.end &&
        control.value.slice(last.start, last.end) === last.text
      ) {
        replacementStart = last.start;
        replacementEnd = last.end;
        selectedText = last.text;
        source = "last-dictated";
      }

      if (options.requireSelection && !selectedText) {
        throw new EditorGuardError(
          "selection-required",
          "Select text before asking Sotto to rewrite it",
        );
      }

      snapshot = {
        kind,
        target: control,
        document: this.document,
        expectedSelectionStart: selectionStart,
        expectedSelectionEnd: selectionEnd,
        replacementStart,
        replacementEnd,
        selectedText,
      };
    } else {
      const editable = target as HTMLElement;
      const range = selectedRange(this.document, editable);
      if (!range) {
        throw new EditorGuardError(
          "unsafe-editor",
          "This editor does not expose a safe selection",
        );
      }
      const selectedText = range.toString();
      if (options.requireSelection && !selectedText) {
        throw new EditorGuardError(
          "selection-required",
          "Select text before asking Sotto to rewrite it",
        );
      }
      source = selectedText ? "selection" : "caret";
      snapshot = {
        kind,
        target: editable,
        document: this.document,
        range: range.cloneRange(),
        selectedText,
      };
    }

    // Only the newest command may own a live DOM snapshot.
    this.#snapshots.clear();
    this.#snapshots.set(snapshotId, snapshot);
    return { snapshotId, selectedText: snapshot.selectedText, source };
  }

  commit(
    snapshotId: string,
    text: string,
    inputType: "insertText" | "insertReplacementText",
  ): EditorCommit {
    const snapshot = this.#snapshots.get(snapshotId);
    this.#snapshots.delete(snapshotId);
    if (!snapshot) {
      throw new EditorGuardError(
        "stale-snapshot",
        "The editor snapshot is no longer valid",
      );
    }
    assertCurrentTarget(snapshot);

    if (snapshot.kind === "input" || snapshot.kind === "textarea") {
      return this.#commitTextControl(snapshot, text, inputType);
    }
    return this.#commitContentEditable(
      snapshot as ContentEditableSnapshot,
      text,
      inputType,
    );
  }

  #commitTextControl(
    snapshot: TextControlSnapshot,
    text: string,
    inputType: "insertText" | "insertReplacementText",
  ): EditorCommit {
    const {
      target,
      expectedSelectionStart,
      expectedSelectionEnd,
      replacementStart,
      replacementEnd,
    } = snapshot;
    if (
      target.selectionStart !== expectedSelectionStart ||
      target.selectionEnd !== expectedSelectionEnd ||
      target.value.slice(replacementStart, replacementEnd) !==
        snapshot.selectedText
    ) {
      throw new EditorGuardError(
        "stale-snapshot",
        "The selection changed before Sotto could type",
      );
    }

    const originalValue = target.value;
    const expected =
      originalValue.slice(0, replacementStart) +
      text +
      originalValue.slice(replacementEnd);
    const before = inputEvent(snapshot.document, "beforeinput", text, inputType);
    if (!target.dispatchEvent(before)) {
      throw new EditorGuardError(
        "beforeinput-cancelled",
        "The editor declined Sotto's text change",
      );
    }
    if (
      target.value !== originalValue ||
      target.selectionStart !== expectedSelectionStart ||
      target.selectionEnd !== expectedSelectionEnd
    ) {
      throw new EditorGuardError(
        "stale-snapshot",
        "The editor changed while handling Sotto's text change",
      );
    }
    target.setRangeText(text, replacementStart, replacementEnd, "end");
    target.dispatchEvent(
      inputEvent(snapshot.document, "input", text, inputType),
    );
    if (target.value !== expected) {
      throw new EditorGuardError(
        "commit-failed",
        "The editor did not preserve Sotto's text change",
      );
    }

    if (inputType === "insertText") {
      this.#lastDictated = {
        target,
        document: snapshot.document,
        start: replacementStart,
        end: replacementStart + text.length,
        text,
      };
    } else {
      this.#lastDictated = undefined;
    }
    return { kind: snapshot.kind };
  }

  #commitContentEditable(
    snapshot: ContentEditableSnapshot,
    text: string,
    inputType: "insertText" | "insertReplacementText",
  ): EditorCommit {
    const current = selectedRange(snapshot.document, snapshot.target);
    if (!current || !rangesMatch(current, snapshot.range)) {
      throw new EditorGuardError(
        "stale-snapshot",
        "The selection changed before Sotto could type",
      );
    }
    if (current.toString() !== snapshot.selectedText) {
      throw new EditorGuardError(
        "stale-snapshot",
        "The selected text changed before Sotto could type",
      );
    }
    if (snapshot.selectedText === text) return { kind: "contenteditable" };

    const beforeText = snapshot.target.textContent ?? "";
    const start = textOffset(snapshot.target, current);
    if (start === null) {
      throw new EditorGuardError(
        "complex-editor",
        "Sotto cannot safely edit this complex editor",
      );
    }
    const expected =
      beforeText.slice(0, start) +
      text +
      beforeText.slice(start + snapshot.selectedText.length);

    snapshot.document.execCommand?.("insertText", false, text);
    if ((snapshot.target.textContent ?? "") === expected) {
      this.#lastDictated = undefined;
      return { kind: "contenteditable" };
    }

    // A failed native edit may still have changed a private editor model.
    if ((snapshot.target.textContent ?? "") !== beforeText) {
      throw new EditorGuardError(
        "commit-failed",
        "The editor made an unexpected text change",
      );
    }
    if (!isSimpleContentEditable(snapshot.target)) {
      throw new EditorGuardError(
        "complex-editor",
        "Sotto cannot safely edit this complex editor",
      );
    }

    const before = inputEvent(snapshot.document, "beforeinput", text, inputType);
    if (!snapshot.target.dispatchEvent(before)) {
      throw new EditorGuardError(
        "beforeinput-cancelled",
        "The editor declined Sotto's text change",
      );
    }

    current.deleteContents();
    const inserted = snapshot.document.createTextNode(text);
    current.insertNode(inserted);
    current.setStartAfter(inserted);
    current.collapse(true);
    const selection = snapshot.document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(current);
    snapshot.target.dispatchEvent(
      inputEvent(snapshot.document, "input", text, inputType),
    );
    if ((snapshot.target.textContent ?? "") !== expected) {
      throw new EditorGuardError(
        "commit-failed",
        "The editor did not preserve Sotto's text change",
      );
    }
    this.#lastDictated = undefined;
    return { kind: "contenteditable" };
  }
}
