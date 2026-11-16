import { z } from "zod";
import {
  ACTIONS_LIST_DEFAULT_LIMIT,
  ACTIONS_LIST_MAX_LIMIT,
  ACTIONS_SEARCH_DEFAULT_LIMIT,
  ACTIONS_SEARCH_MAX_LIMIT,
} from "../config/mcpIntrospection.js";

/**
 * `actions.list` and `actions.search` over a manifest, shared because two
 * processes answer them: the renderer from its live registry, and a host with
 * no view from its generated catalog (#13493), so the hub's assistant can find
 * a headless host's tools. Main narrows either answer to the caller's surface
 * afterwards, so these only page and rank.
 */

export const ActionsListArgsSchema = z
  .object({
    category: z.string().optional().describe("Exact category, e.g. terminal, worktree, forge"),
    search: z.string().optional().describe("Substring of id, title or description"),
    enabledOnly: z.boolean().optional().describe("Only enabled actions (default false)"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(ACTIONS_LIST_MAX_LIMIT)
      .optional()
      .default(ACTIONS_LIST_DEFAULT_LIMIT)
      .describe(`Max actions, 1-${ACTIONS_LIST_MAX_LIMIT} (default ${ACTIONS_LIST_DEFAULT_LIMIT})`),
    offset: z.number().int().min(0).optional().default(0).describe("Matches to skip (default 0)"),
  })
  .optional();

export const ActionsSearchArgsSchema = z.object({
  query: z
    .string()
    .min(1)
    .refine((s) => s.trim().length > 0, "must contain non-whitespace text")
    .describe("Natural-language query or keywords"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(ACTIONS_SEARCH_MAX_LIMIT)
    .optional()
    .default(ACTIONS_SEARCH_DEFAULT_LIMIT)
    .describe(
      `Max results, 1-${ACTIONS_SEARCH_MAX_LIMIT} (default ${ACTIONS_SEARCH_DEFAULT_LIMIT})`
    ),
});

export const ActionsGetSchemaArgsSchema = z.object({
  actionId: z
    .string()
    .min(1)
    .describe("Action id from search or listing, passed as a value; not a tool name."),
});
