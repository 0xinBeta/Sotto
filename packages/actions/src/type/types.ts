export const REWRITE_TRANSFORMATIONS = [
  "more-formal",
  "more-casual",
  "clearer",
  "fix-grammar",
  "shorter",
  "longer",
  "friendlier",
  "bullets",
] as const;

export type RewriteTransformation =
  (typeof REWRITE_TRANSFORMATIONS)[number];

export type TypeCommand =
  | {
      readonly action: "type";
      readonly operation: "dictate";
      /** Copied only from the user's parsed transcript. */
      readonly text: string;
    }
  | {
      readonly action: "type";
      readonly operation: "rewrite";
      /** A parser-selected closed enum; never page- or model-derived text. */
      readonly transformation: RewriteTransformation;
    };

export interface EditorCaptureOptions {
  readonly requireSelection: boolean;
  readonly allowLastDictated: boolean;
}

export interface EditorCapture {
  readonly snapshotId: string;
  readonly targetId: string;
  readonly selectedText: string;
  readonly source: "caret" | "selection" | "last-dictated";
}

export interface EditorCommit {
  readonly kind: "input" | "textarea" | "contenteditable";
}

/**
 * Narrow worker-owned integration seam. The action deliberately does not know
 * how the service worker reaches the content script or the offscreen model.
 */
export interface TypeActionServices {
  capture(options: EditorCaptureOptions): Promise<EditorCapture>;
  commit(options: {
    readonly snapshotId: string;
    readonly text: string;
    readonly inputType: "insertText" | "insertReplacementText";
    readonly rememberAsDictation: boolean;
  }): Promise<EditorCommit>;
  rewrite(options: {
    readonly snapshotId: string;
    readonly source: string;
    readonly transformation: RewriteTransformation;
  }): Promise<string>;
}

export interface TypeActionContext {
  readonly type?: TypeActionServices;
}
