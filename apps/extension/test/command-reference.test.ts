import { describe, expect, it } from "vitest";

import {
  ActionRegistry,
  defineAction,
  type ActionDefinition,
} from "@sotto/core";
import {
  createCommandReference,
  renderCommandReference,
} from "../src/command-reference.js";

class TestElement {
  readonly children: TestElement[] = [];
  className = "";
  private copy = "";

  get textContent(): string {
    return this.copy + this.children.map((child) => child.textContent).join("");
  }

  set textContent(value: string) {
    this.copy = value;
    this.children.length = 0;
  }

  append(...children: TestElement[]): void {
    this.children.push(...children);
  }

  replaceChildren(...children: TestElement[]): void {
    this.children.length = 0;
    this.append(...children);
  }
}

function action(
  id: string,
  title: string,
  phrase: string,
): ActionDefinition {
  return defineAction({
    id,
    title,
    permissions: [],
    schema: {
      type: "object",
      properties: { action: { const: id } },
      required: ["action"],
      additionalProperties: false,
    },
    examples: [{ say: phrase, emit: { action: id } }],
    confirm: false,
    async execute() {
      return { spoken: "Done." };
    },
  });
}

describe("command reference", () => {
  it("renders new registry actions without a hardcoded panel list", () => {
    const registry = new ActionRegistry([
      action("first", "First action", "run the first action"),
    ]);
    const container = new TestElement();
    const documentFactory = {
      createElement: () => new TestElement(),
    };
    const render = () =>
      renderCommandReference(
        createCommandReference(registry),
        container as unknown as HTMLElement,
        documentFactory as unknown as Pick<Document, "createElement">,
      );

    render();
    expect(container.textContent).toContain(
      "First actionrun the first action",
    );
    expect(container.children).toHaveLength(1);

    registry.register(
      action("second", "Second action", "run the second action"),
    );
    render();

    expect(container.textContent).toContain(
      "Second actionrun the second action",
    );
    expect(container.children).toHaveLength(2);
  });
});
