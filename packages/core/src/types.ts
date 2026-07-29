export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface JsonSchema {
  readonly type?:
    | "null"
    | "boolean"
    | "object"
    | "array"
    | "number"
    | "integer"
    | "string"
    | readonly (
        | "null"
        | "boolean"
        | "object"
        | "array"
        | "number"
        | "integer"
        | "string"
      )[];
  readonly title?: string;
  readonly description?: string;
  readonly const?: JsonValue;
  readonly enum?: readonly JsonValue[];
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | JsonSchema;
  readonly items?: JsonSchema;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly pattern?: string;
  readonly oneOf?: readonly JsonSchema[];
  readonly anyOf?: readonly JsonSchema[];
}

export interface ActionCommand {
  readonly action: string;
}

export interface ActionExample<TCommand extends ActionCommand = ActionCommand> {
  readonly say: string;
  readonly emit: TCommand;
}

export interface ImageDestinationInput {
  readonly kind: "image";
  readonly mimeType: "image/png";
  readonly dataUrl: string;
}

export type DestinationInput = ImageDestinationInput;

export interface FocusOrOpenTabFollowUp {
  readonly kind: "focus-or-open-tab";
  readonly matchPatterns: readonly string[];
  readonly createUrl: string;
}

export type DestinationFollowUp = FocusOrOpenTabFollowUp;

export interface ClipboardWorkflow {
  readonly kind: "clipboard-write";
  readonly id: string;
  readonly requiresFocus: true;
  readonly requiresUserActivation: true;
  readonly buttonLabel: string;
  readonly item: {
    readonly kind: "image";
    readonly mimeType: "image/png";
    readonly dataUrl: string;
  };
  readonly afterWrite?: {
    readonly followUp?: DestinationFollowUp;
    readonly spoken?: string;
  };
}

export interface ScreenshotPermissionWorkflow {
  readonly kind: "screenshot-permission";
  readonly originPattern: string;
  readonly host: string;
  readonly pendingCommand: ActionCommand;
}

export interface PanelCommandReferenceWorkflow {
  readonly kind: "panel-command-reference";
}

export type ClientWorkflow =
  | ClipboardWorkflow
  | ScreenshotPermissionWorkflow
  | PanelCommandReferenceWorkflow;

export interface ActionResult {
  readonly spoken: string;
  /** Logs a successful result without speech or an earcon. */
  readonly silent?: true;
  /** Tells the worker to replay its speech-only session value. */
  readonly replayLastSpoken?: true;
  readonly workflow?: ClientWorkflow;
  readonly data?: Readonly<Record<string, JsonValue>>;
  /**
   * Untrusted page-derived text has exactly two sinks: inert panel text and
   * local TTS. The worker handles this presentation before the generic
   * responder path so it can never become parser input or action data.
   */
  readonly pageText?: {
    readonly text: string;
    readonly title?: string;
    readonly lang?: string;
    readonly speech: "short" | "long";
  };
}

export interface ExtractedPageText {
  readonly text: string;
  readonly title: string;
  readonly url: string;
  readonly language?: string;
  readonly source:
    | "selection"
    | "readability"
    | "article"
    | "main"
    | "body";
  readonly truncated: boolean;
}

export type PageModelTask =
  | {
      readonly role: "summarize";
      readonly page: ExtractedPageText;
    }
  | {
      readonly role: "ask-page";
      readonly page: ExtractedPageText;
      readonly question: string;
    };

export type PageTranslationAvailability =
  | "unavailable"
  | "downloadable"
  | "downloading"
  | "available";

export type PageTranslationResult =
  | {
      readonly availability: "unavailable";
    }
  | {
      readonly availability: Exclude<
        PageTranslationAvailability,
        "unavailable"
      >;
      readonly text: string;
    };

export interface PageActionServices {
  extract(options: {
    readonly preferSelection: boolean;
    readonly requireSelection?: boolean;
  }): Promise<ExtractedPageText>;
  runModelTask(task: PageModelTask): Promise<string>;
  translate(options: {
    readonly page: ExtractedPageText;
    readonly targetLanguage: string;
  }): Promise<PageTranslationResult>;
}

export interface EditableActionServices {
  capture(options: {
    readonly requireSelection: boolean;
    readonly allowLastDictated: boolean;
  }): Promise<{
    readonly snapshotId: string;
    readonly selectedText: string;
    readonly source: "caret" | "selection" | "last-dictated";
  }>;
  rewrite(options: {
    readonly snapshotId: string;
    readonly source: string;
    readonly transformation:
      | "more-formal"
      | "more-casual"
      | "clearer"
      | "fix-grammar"
      | "shorter"
      | "longer"
      | "friendlier"
      | "bullets";
  }): Promise<string>;
  commit(options: {
    readonly snapshotId: string;
    readonly text: string;
    readonly inputType: "insertText" | "insertReplacementText";
    readonly rememberAsDictation: boolean;
  }): Promise<{
    readonly kind: "input" | "textarea" | "contenteditable";
  }>;
}

export interface DictationActionServices {
  start(): Promise<string>;
  stop(): Promise<string>;
}

export type ScreenQuestionResult =
  | {
      readonly availability: "unavailable";
    }
  | {
      readonly availability: "downloadable" | "downloading" | "available";
      readonly text: string;
    };

export interface ScreenQuestionServices {
  ask(options: {
    readonly imageDataUrl: string;
    readonly question?: string;
  }): Promise<ScreenQuestionResult>;
}

export interface ActionCatalog {
  list(): readonly ActionDefinition[];
}

export interface ActionContext {
  /**
   * Supplied by the service-worker router. Actions use it instead of importing
   * destination plugins, keeping the plugin graph acyclic.
   */
  readonly dispatchDestination?: (
    destinationId: string,
    input: DestinationInput,
  ) => Promise<ActionResult>;
  /** Worker-owned bridge to isolated extraction and offscreen page models. */
  readonly page?: PageActionServices;
  /** Worker-owned bridge to the captured editable range. */
  readonly type?: EditableActionServices;
  /** Worker-owned continuous dictation session. */
  readonly dictation?: DictationActionServices;
  /** Worker-owned bridge from a visible-tab image to an isolated screen model. */
  readonly screen?: ScreenQuestionServices;
  /** Registry metadata for actions that present command help. */
  readonly actionCatalog?: ActionCatalog;
}

export interface DestinationContext {
  /**
   * Reserved for worker-owned services (logging, session state, etc.). v0.1
   * destinations do not require a concrete context.
   */
  readonly services?: Readonly<Record<string, unknown>>;
}

export interface ActionDefinition<
  TCommand extends ActionCommand = ActionCommand,
> {
  readonly id: TCommand["action"] & string;
  readonly title: string;
  readonly permissions: readonly string[];
  readonly schema: JsonSchema;
  readonly examples: readonly ActionExample<TCommand>[];
  readonly confirm:
    | boolean
    | ((command: ActionCommand) => boolean);
  execute(command: TCommand, context: ActionContext): Promise<ActionResult>;
}

export interface DestinationDefinition<
  TInput extends DestinationInput = DestinationInput,
> {
  readonly id: string;
  readonly title: string;
  readonly permissions: readonly string[];
  execute(input: TInput, context: DestinationContext): Promise<ActionResult>;
}

export function defineAction<TCommand extends ActionCommand>(
  definition: ActionDefinition<TCommand>,
): ActionDefinition<TCommand> {
  return definition;
}

export function defineDestination<TInput extends DestinationInput>(
  definition: DestinationDefinition<TInput>,
): DestinationDefinition<TInput> {
  return definition;
}
