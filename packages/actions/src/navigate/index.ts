import { defineAction } from "@sotto/core";
import type { JsonSchema } from "@sotto/core";

export type NavigateCommand =
  | {
      readonly action: "navigate";
      readonly operation: "open";
      readonly site: string;
    }
  | {
      readonly action: "navigate";
      readonly operation: "search";
      readonly query: string;
    };

export const navigateSchema = {
  oneOf: [
    {
      type: "object",
      properties: {
        action: { const: "navigate" },
        operation: { const: "open" },
        site: {
          type: "string",
          minLength: 4,
          maxLength: 100,
          description:
            "A hostname from the transcript without a protocol, path, or spaces",
        },
      },
      required: ["action", "operation", "site"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        action: { const: "navigate" },
        operation: { const: "search" },
        query: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description: "A web search query copied only from the transcript",
        },
      },
      required: ["action", "operation", "query"],
      additionalProperties: false,
    },
  ],
} as const satisfies JsonSchema;

const HOSTNAME_PATTERN =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;

export function sanitizeHostname(site: string): string | undefined {
  const host = site.trim().toLowerCase();
  if (host.length < 4 || host.length > 100) return undefined;
  if (!HOSTNAME_PATTERN.test(host)) return undefined;
  return host;
}

const navigateAction = defineAction<NavigateCommand>({
  id: "navigate",
  title: "Open sites and search",
  permissions: ["tabs"],
  schema: navigateSchema,
  examples: [
    {
      say: "open github.com",
      emit: { action: "navigate", operation: "open", site: "github.com" },
    },
    {
      say: "go to wikipedia.org",
      emit: {
        action: "navigate",
        operation: "open",
        site: "wikipedia.org",
      },
    },
    {
      say: "search the web for chrome extensions",
      emit: {
        action: "navigate",
        operation: "search",
        query: "chrome extensions",
      },
    },
  ],
  confirm: false,
  async execute(command) {
    if (command.operation === "search") {
      const query = command.query.trim();
      if (query === "") {
        return { spoken: "I did not catch a search query." };
      }
      await chrome.tabs.create({
        url: `https://www.google.com/search?q=${encodeURIComponent(query)}`,
        active: true,
      });
      return { spoken: "Searching." };
    }

    const host = sanitizeHostname(command.site);
    if (host === undefined) {
      return { spoken: "I did not catch a site name." };
    }
    await chrome.tabs.create({
      url: `https://${host}/`,
      active: true,
    });
    return { spoken: `Opening ${host}.` };
  },
});

export default navigateAction;
