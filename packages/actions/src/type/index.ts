import { defineAction } from "@sotto/core";
import type { ActionContext } from "@sotto/core";
import { typeActionSchema } from "./schema.js";
import type {
  TypeActionContext,
  TypeActionServices,
  TypeCommand,
} from "./types.js";

function servicesFrom(context: ActionContext): TypeActionServices {
  const services = (context as ActionContext & TypeActionContext).type;
  if (!services) {
    throw new Error("Typing requires editor services in ActionContext");
  }
  return services;
}

const typeAction = defineAction<TypeCommand>({
  id: "type",
  title: "Type",
  permissions: ["activeTab", "scripting"],
  schema: typeActionSchema,
  examples: [
    {
      say: "type: sounds good, see you at five",
      emit: {
        action: "type",
        operation: "dictate",
        text: "sounds good, see you at five",
      },
    },
    {
      say: "write thanks for the update",
      emit: {
        action: "type",
        operation: "dictate",
        text: "thanks for the update",
      },
    },
    {
      say: "make it more formal",
      emit: {
        action: "type",
        operation: "rewrite",
        transformation: "more-formal",
      },
    },
    {
      say: "fix the grammar in this",
      emit: {
        action: "type",
        operation: "rewrite",
        transformation: "fix-grammar",
      },
    },
  ],
  confirm: false,
  async execute(command, context) {
    const services = servicesFrom(context);

    if (command.operation === "dictate") {
      const snapshot = await services.capture({
        requireSelection: false,
        allowLastDictated: false,
      });
      await services.commit({
        snapshotId: snapshot.snapshotId,
        text: command.text,
        inputType:
          snapshot.source === "selection"
            ? "insertReplacementText"
            : "insertText",
      });
      return { spoken: "Typed it." };
    }

    // The focused target and selected source are captured before model work.
    const snapshot = await services.capture({
      requireSelection: true,
      allowLastDictated: true,
    });
    const rewritten = await services.rewrite({
      source: snapshot.selectedText,
      transformation: command.transformation,
    });
    await services.commit({
      snapshotId: snapshot.snapshotId,
      text: rewritten,
      inputType: "insertReplacementText",
    });
    return { spoken: "Rewrote the selection." };
  },
});

export default typeAction;
export { typeActionSchema } from "./schema.js";
export {
  EditorSnapshotSession,
  deepActiveElement,
  editableKind,
  isSafeEditable,
} from "./editor.js";
export {
  installTypeContentScriptBridge,
  type TypeBridgeMessage,
  type TypeBridgeResponse,
} from "./bridge.js";
export {
  REWRITE_TRANSFORMATIONS,
  type EditorCapture,
  type EditorCaptureOptions,
  type EditorCommit,
  type RewriteTransformation,
  type TypeActionContext,
  type TypeActionServices,
  type TypeCommand,
} from "./types.js";
