import chatgptDestination from "./chatgpt/index.js";
import claudeDestination from "./claude/index.js";
import copyDestination from "./copy/index.js";
import fileDestination from "./file/index.js";
import geminiDestination from "./gemini/index.js";

export { default as chatgptDestination } from "./chatgpt/index.js";
export { default as claudeDestination } from "./claude/index.js";
export { default as copyDestination } from "./copy/index.js";
export {
  createScreenshotFilename,
  default as fileDestination,
} from "./file/index.js";
export { default as geminiDestination } from "./gemini/index.js";
export * from "./workflow.js";

export const destinations = [
  copyDestination,
  fileDestination,
  claudeDestination,
  chatgptDestination,
  geminiDestination,
] as const;
export default destinations;
