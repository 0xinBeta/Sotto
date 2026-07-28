import type { ClipboardWorkflow } from "@sotto/core";
import type { ClipboardWorkflowCompletion } from "@sotto/destinations";

const IMAGE_DOCUMENT_LOAD_TIMEOUT_MS = 5_000;

async function loadPng(dataUrl: string, mimeType: "image/png"): Promise<Blob> {
  const response = await fetch(dataUrl);
  if (!response.ok) {
    throw new Error("Could not prepare the screenshot for the clipboard");
  }
  const blob = await response.blob();
  if (blob.type !== mimeType) {
    throw new TypeError(`Expected ${mimeType}, got ${blob.type}`);
  }
  return blob;
}

function loadImageDocument(
  frame: HTMLIFrameElement,
  objectUrl: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => {
      reject(new Error("Timed out while preparing the screenshot clipboard"));
    }, IMAGE_DOCUMENT_LOAD_TIMEOUT_MS);

    frame.addEventListener(
      "load",
      () => {
        globalThis.clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
    frame.addEventListener(
      "error",
      () => {
        globalThis.clearTimeout(timeout);
        reject(new Error("Could not load the screenshot clipboard image"));
      },
      { once: true },
    );
    frame.src = objectUrl;
    document.body.append(frame);
  });
}

/**
 * Chrome's async Clipboard API rejects in offscreen documents because they
 * cannot be focused. A PNG loaded as an image document takes Blink's native
 * image-copy path, which writes an image/png representation via execCommand.
 */
export async function performOffscreenClipboardWorkflow(
  workflow: ClipboardWorkflow,
): Promise<ClipboardWorkflowCompletion> {
  if (workflow.kind !== "clipboard-write") {
    throw new TypeError("Unsupported destination workflow");
  }

  const blob = await loadPng(workflow.item.dataUrl, workflow.item.mimeType);
  const objectUrl = URL.createObjectURL(blob);
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText =
    "position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;border:0";

  try {
    await loadImageDocument(frame, objectUrl);
    const imageDocument = frame.contentDocument;
    if (!imageDocument || imageDocument.contentType !== workflow.item.mimeType) {
      throw new DOMException(
        "Chrome did not create a PNG image document",
        "NotSupportedError",
      );
    }
    if (!imageDocument.execCommand("copy")) {
      throw new DOMException(
        "Chrome rejected the automatic image copy",
        "NotAllowedError",
      );
    }
  } finally {
    frame.remove();
    URL.revokeObjectURL(objectUrl);
  }

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
