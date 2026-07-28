import screenshotAction from "./screenshot/index.js";
import tabsAction from "./tabs/index.js";

export { default as screenshotAction } from "./screenshot/index.js";
export type {
  ScreenshotCommand,
  ScreenshotDestination,
} from "./screenshot/index.js";
export * from "./tabs/index.js";

export { default as tabsAction } from "./tabs/index.js";

export const actions = [screenshotAction, tabsAction] as const;
export default actions;
