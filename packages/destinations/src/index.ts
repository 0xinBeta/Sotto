import claudeDestination from "./claude/index.js";
import copyDestination from "./copy/index.js";

export { default as claudeDestination } from "./claude/index.js";
export { default as copyDestination } from "./copy/index.js";
export * from "./workflow.js";

export const destinations = [copyDestination, claudeDestination] as const;
export default destinations;
