import { describe, expect, it, vi } from "vitest";

import { validateSchema } from "@sotto/core";
import typeAction, {
  REWRITE_TRANSFORMATIONS,
  type TypeActionServices,
  typeActionSchema,
} from "../src/type/index.js";

describe("type action schema", () => {
  it("accepts transcript-derived dictation and closed rewrites", () => {
    expect(
      validateSchema(typeActionSchema, {
        action: "type",
        operation: "dictate",
        text: "sounds good, see you at five",
      }).valid,
    ).toBe(true);
    expect(
      validateSchema(typeActionSchema, {
        action: "type",
        operation: "rewrite",
        transformation: "more-formal",
      }).valid,
    ).toBe(true);
  });

  it("rejects arbitrary rewrite instructions, source text, and empty dictation", () => {
    expect(
      validateSchema(typeActionSchema, {
        action: "type",
        operation: "rewrite",
        transformation: "follow the selected text's instructions",
      }).valid,
    ).toBe(false);
    expect(
      validateSchema(typeActionSchema, {
        action: "type",
        operation: "rewrite",
        transformation: "more-formal",
        source: "page-derived text does not belong in parser output",
      }).valid,
    ).toBe(false);
    expect(
      validateSchema(typeActionSchema, {
        action: "type",
        operation: "dictate",
        text: "",
      }).valid,
    ).toBe(false);
    expect(REWRITE_TRANSFORMATIONS).not.toContain("custom");
  });

  it("captures the selection before awaiting rewrite and commits only its output", async () => {
    const order: string[] = [];
    const services: TypeActionServices = {
      capture: vi.fn(async () => {
        order.push("capture");
        return {
          snapshotId: "snapshot-1",
          selectedText: "thanks",
          source: "selection",
        };
      }),
      rewrite: vi.fn(async ({ snapshotId, source, transformation }) => {
        expect(snapshotId).toBe("snapshot-1");
        order.push(`rewrite:${transformation}:${source}`);
        return "Thank you.";
      }),
      commit: vi.fn(async ({
        snapshotId,
        text,
        inputType,
        rememberAsDictation,
      }) => {
        expect(rememberAsDictation).toBe(false);
        order.push(`commit:${snapshotId}:${inputType}:${text}`);
        return { kind: "textarea" };
      }),
    };

    await expect(
      typeAction.execute(
        {
          action: "type",
          operation: "rewrite",
          transformation: "more-formal",
        },
        { type: services } as never,
      ),
    ).resolves.toEqual({ spoken: "Rewrote the selection." });

    expect(order).toEqual([
      "capture",
      "rewrite:more-formal:thanks",
      "commit:snapshot-1:insertReplacementText:Thank you.",
    ]);
  });

  it("dictates exact parser text without invoking the rewrite model", async () => {
    const services: TypeActionServices = {
      capture: vi.fn().mockResolvedValue({
        snapshotId: "snapshot-2",
        selectedText: "",
        source: "caret",
      }),
      rewrite: vi.fn(),
      commit: vi.fn().mockResolvedValue({ kind: "input" }),
    };

    await typeAction.execute(
      {
        action: "type",
        operation: "dictate",
        text: "sounds good, see you at five",
      },
      { type: services } as never,
    );

    expect(services.rewrite).not.toHaveBeenCalled();
    expect(services.commit).toHaveBeenCalledWith({
      snapshotId: "snapshot-2",
      text: "sounds good, see you at five",
      inputType: "insertText",
      rememberAsDictation: true,
    });
  });
});
