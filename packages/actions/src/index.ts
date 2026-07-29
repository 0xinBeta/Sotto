import askPageAction from "./ask-page/index.js";
import dictationAction from "./dictation/index.js";
import helpAction from "./help/index.js";
import navigateAction from "./navigate/index.js";
import notesAction from "./notes/index.js";
import pageControlAction from "./page-control/index.js";
import playbackAction from "./playback/index.js";
import quietModeAction from "./quiet-mode/index.js";
import repeatAction from "./repeat/index.js";
import screenshotAction from "./screenshot/index.js";
import summarizeAction from "./summarize/index.js";
import tabsAction from "./tabs/index.js";
import translateAction from "./translate/index.js";
import typeAction from "./type/index.js";

export { default as askPageAction } from "./ask-page/index.js";
export type { AskPageCommand } from "./ask-page/index.js";
export {
  default as dictationAction,
  dictationSchema,
} from "./dictation/index.js";
export type {
  DictationCommand,
  DictationOperation,
} from "./dictation/index.js";
export {
  default as helpAction,
  HELP_SUMMARY_MAX_CHARACTERS,
  createCommandReading,
  createHelpSummary,
  helpSchema,
} from "./help/index.js";
export type {
  HelpCommand,
  HelpMode,
} from "./help/index.js";
export {
  default as notesAction,
  notesSchema,
} from "./notes/index.js";
export type { NotesCommand } from "./notes/index.js";
export {
  default as navigateAction,
  navigateSchema,
  sanitizeHostname,
} from "./navigate/index.js";
export type { NavigateCommand } from "./navigate/index.js";
export {
  calculateZoomLevel,
  default as pageControlAction,
  isRestrictedPage,
  pageControlSchema,
  runScrollOperation,
  zoomFeedback,
} from "./page-control/index.js";
export type {
  PageControlCommand,
  PageControlOperation,
  ScrollOperation,
  ZoomOperation,
} from "./page-control/index.js";
export {
  default as playbackAction,
  playbackSchema,
} from "./playback/index.js";
export type {
  PlaybackCommand,
  PlaybackOperation,
} from "./playback/index.js";
export {
  default as quietModeAction,
  quietModeSchema,
} from "./quiet-mode/index.js";
export type {
  QuietModeCommand,
  QuietModeOperation,
} from "./quiet-mode/index.js";
export {
  default as repeatAction,
  EMPTY_REPEAT_RESPONSE,
  repeatSchema,
} from "./repeat/index.js";
export type { RepeatCommand } from "./repeat/index.js";
export { default as screenshotAction } from "./screenshot/index.js";
export type {
  ScreenshotCommand,
  ScreenshotDestination,
} from "./screenshot/index.js";
export * from "./tabs/index.js";
export {
  default as typeAction,
  typeActionSchema,
} from "./type/index.js";
export type {
  RewriteTransformation,
  TypeActionServices,
  TypeCommand,
} from "./type/index.js";
export {
  default as summarizeAction,
  summarizeSchema,
} from "./summarize/index.js";
export type {
  PageScope,
  SummarizeCommand,
  SummarizeMode,
} from "./summarize/index.js";
export {
  default as translateAction,
  TRANSLATE_LANGUAGE_CODES,
  TRANSLATE_LANGUAGE_LABELS,
  translateSchema,
} from "./translate/index.js";
export type {
  TranslateCommand,
  TranslateLanguage,
  TranslateScope,
} from "./translate/index.js";

export { default as tabsAction } from "./tabs/index.js";

export const actions = [
  screenshotAction,
  tabsAction,
  translateAction,
  summarizeAction,
  askPageAction,
  navigateAction,
  notesAction,
  pageControlAction,
  playbackAction,
  quietModeAction,
  repeatAction,
  typeAction,
  dictationAction,
  helpAction,
] as const;
export default actions;
