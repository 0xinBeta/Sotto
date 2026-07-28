import type {
  ClipboardWorkflow,
  DestinationFollowUp,
  ImageDestinationInput,
} from "@sotto/core";

let workflowSequence = 0;

export function createClipboardWorkflow(
  input: ImageDestinationInput,
  options: {
    readonly buttonLabel?: string;
    readonly afterWrite?: ClipboardWorkflow["afterWrite"];
  } = {},
): ClipboardWorkflow {
  workflowSequence += 1;
  return {
    kind: "clipboard-write",
    id: `clipboard-${Date.now()}-${workflowSequence}`,
    requiresFocus: true,
    requiresUserActivation: true,
    buttonLabel: options.buttonLabel ?? "Copy screenshot",
    item: {
      kind: "image",
      mimeType: input.mimeType,
      dataUrl: input.dataUrl,
    },
    ...(options.afterWrite === undefined
      ? {}
      : { afterWrite: options.afterWrite }),
  };
}

export interface ClipboardWorkflowCompletion {
  readonly workflowId: string;
  readonly followUp?: DestinationFollowUp;
  readonly spoken?: string;
}

/**
 * Call this directly from the side-panel Copy button. Clipboard.write requires
 * both a focused document and transient user activation.
 */
export async function performClipboardWorkflow(
  workflow: ClipboardWorkflow,
): Promise<ClipboardWorkflowCompletion> {
  if (workflow.kind !== "clipboard-write") {
    throw new TypeError("Unsupported destination workflow");
  }
  if (typeof document !== "undefined" && !document.hasFocus()) {
    throw new DOMException(
      "Focus the Sotto side panel, then click Copy again",
      "NotAllowedError",
    );
  }
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    throw new DOMException(
      "Image clipboard writes are unavailable in this document",
      "NotSupportedError",
    );
  }

  const response = await fetch(workflow.item.dataUrl);
  if (!response.ok) {
    throw new Error("Could not prepare the screenshot for the clipboard");
  }
  const blob = await response.blob();
  if (blob.type !== workflow.item.mimeType) {
    throw new TypeError(`Expected ${workflow.item.mimeType}, got ${blob.type}`);
  }
  await navigator.clipboard.write([
    new ClipboardItem({ [workflow.item.mimeType]: blob }),
  ]);

  return {
    workflowId: workflow.id,
    ...(workflow.afterWrite?.followUp === undefined
      ? {}
      : { followUp: workflow.afterWrite.followUp }),
    ...(workflow.afterWrite?.spoken === undefined
      ? {}
      : { spoken: workflow.afterWrite.spoken }),
  };
}

/**
 * Execute a completed workflow's browser follow-up in the service worker.
 * Keeping this separate prevents clipboard code from being attempted in the
 * worker and keeps tab ownership out of the side panel.
 */
export async function executeDestinationFollowUp(
  followUp: DestinationFollowUp,
): Promise<void> {
  switch (followUp.kind) {
    case "focus-or-open-tab": {
      const matching = await chrome.tabs.query({
        url: [...followUp.matchPatterns],
      });
      const tab = matching.find((candidate) => candidate.id !== undefined);
      if (tab?.id !== undefined) {
        await chrome.tabs.update(tab.id, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
        return;
      }
      await chrome.tabs.create({ url: followUp.createUrl, active: true });
      return;
    }
  }
}
