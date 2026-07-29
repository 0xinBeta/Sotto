import { defineDestination } from "@sotto/core";
import type { ImageDestinationInput } from "@sotto/core";

function pad(value: number, length = 2): string {
  return String(value).padStart(length, "0");
}

export function createScreenshotFilename(now = new Date()): string {
  const timestamp = [
    pad(now.getFullYear(), 4),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`,
  ].join("-");
  return `sotto-screenshot-${timestamp}.png`;
}

const fileDestination = defineDestination<ImageDestinationInput>({
  id: "save",
  title: "Save",
  permissions: ["downloads"],
  async execute(input) {
    try {
      // A data URL avoids Blob URL lifecycle work in the service worker.
      // If Chrome's URL limit is reached, create the Blob URL offscreen instead.
      await chrome.downloads.download({
        url: input.dataUrl,
        filename: createScreenshotFilename(),
        conflictAction: "uniquify",
        saveAs: false,
      });
      return { spoken: "Screenshot saved to Downloads." };
    } catch {
      return { spoken: "I could not save the screenshot." };
    }
  },
});

export default fileDestination;
