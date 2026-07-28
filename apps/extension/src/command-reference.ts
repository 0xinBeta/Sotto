import type { ActionRegistry } from "@sotto/core";

export interface CommandReferenceGroup {
  readonly id: string;
  readonly title: string;
  readonly examples: readonly string[];
}

type RegistryReferenceSource = Pick<ActionRegistry, "examples" | "list">;
type DocumentFactory = Pick<Document, "createElement">;

export function createCommandReference(
  registry: RegistryReferenceSource,
): readonly CommandReferenceGroup[] {
  const examples = registry.examples;
  return registry.list().map((action) => ({
    id: action.id,
    title: action.title,
    examples: examples
      .filter((example) => example.emit.action === action.id)
      .map((example) => example.say),
  }));
}

export function isCommandReference(
  value: unknown,
): value is readonly CommandReferenceGroup[] {
  return (
    Array.isArray(value) &&
    value.length <= 100 &&
    value.every(
      (group) =>
        typeof group === "object" &&
        group !== null &&
        !Array.isArray(group) &&
        typeof group.id === "string" &&
        group.id.length >= 1 &&
        group.id.length <= 100 &&
        typeof group.title === "string" &&
        group.title.length >= 1 &&
        group.title.length <= 200 &&
        Array.isArray(group.examples) &&
        group.examples.length <= 100 &&
        group.examples.every(
          (example: unknown) =>
            typeof example === "string" &&
            example.length >= 1 &&
            example.length <= 2_000,
        ),
    )
  );
}

export function renderCommandReference(
  reference: readonly CommandReferenceGroup[],
  container: HTMLElement,
  documentFactory: DocumentFactory = document,
): void {
  const groups = reference.map((group) => {
    const section = documentFactory.createElement("section");
    const title = documentFactory.createElement("h3");
    const examples = documentFactory.createElement("ul");
    section.className = "command-group";
    title.textContent = group.title;
    for (const phrase of group.examples) {
      const item = documentFactory.createElement("li");
      item.textContent = phrase;
      examples.append(item);
    }
    section.append(title, examples);
    return section;
  });
  container.replaceChildren(...groups);
}
