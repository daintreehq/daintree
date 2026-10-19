import { z } from "zod";
import type { ActionManifestEntry } from "../types/actions.js";
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

export interface ActionsListPage {
  actions: ActionManifestEntry[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export function listActionManifest(
  entries: readonly ActionManifestEntry[],
  args: {
    category?: string;
    search?: string;
    enabledOnly?: boolean;
    limit?: number;
    offset?: number;
  } = {}
): ActionsListPage {
  const { category, search, enabledOnly, limit = ACTIONS_LIST_DEFAULT_LIMIT, offset = 0 } = args;
  let manifest = entries.filter((entry) => entry.mcpVisibility !== "hidden");

  if (category) {
    manifest = manifest.filter((a) => a.category === category);
  }
  if (search) {
    const q = search.toLowerCase();
    manifest = manifest.filter(
      (a) =>
        (a.id ?? "").toLowerCase().includes(q) ||
        (a.title ?? "").toLowerCase().includes(q) ||
        (a.description ?? "").toLowerCase().includes(q)
    );
  }
  if (enabledOnly) {
    manifest = manifest.filter((a) => a.enabled);
  }

  // Count after filtering but before paging so `total`/`hasMore` describe
  // the whole match set, not the slice the caller happens to be holding.
  const total = manifest.length;
  // Sort before slicing: the registry is a Map, and re-registering a plugin
  // action (usePluginActions replaces any whose descriptor changed) moves it
  // to the end of insertion order. An offset walk over that order could
  // repeat one entry and skip another. Compared by code unit rather than
  // localeCompare so page boundaries don't shift with the host locale —
  // ids are opaque ASCII identifiers, so collation buys nothing here.
  manifest.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const page = manifest.slice(offset, offset + limit);

  return {
    actions: page,
    total,
    limit,
    offset,
    hasMore: offset + page.length < total,
  };
}

export function searchActionManifest(
  entries: readonly ActionManifestEntry[],
  query: string,
  limit: number = ACTIONS_SEARCH_DEFAULT_LIMIT
): { totalMatches: number; results: ActionManifestEntry[] } {
  const q = query.toLowerCase();
  const qTerms = q.split(/\s+/).filter((t) => t.length > 0);

  const scored: Array<{ entry: ActionManifestEntry; score: number }> = [];

  for (const entry of entries) {
    if (entry.mcpVisibility === "hidden") continue;

    const id = (entry.id ?? "").toLowerCase();
    const title = (entry.title ?? "").toLowerCase();
    const description = (entry.description ?? "").toLowerCase();
    const category = (entry.category ?? "").toLowerCase();
    const keywords = (entry.keywords ?? []).join(" ").toLowerCase();
    const keywordTokens = new Set(keywords.split(/\s+/));

    let score = 0;

    for (const term of qTerms) {
      if (id === term) {
        score += 50;
      } else if (id.includes(term)) {
        score += 25;
      }
      if (title.includes(term)) {
        score += 15;
      }
      // Keywords are synonyms: they score only for a word the id and title
      // don't already carry, so an action that restates its title in
      // keywords doesn't count the same word twice. One the query names
      // outright is weighted like an id match — that is what lets "spawn"
      // lift `agent.launch` past siblings that merely share the query's noun.
      if (!id.includes(term) && !title.includes(term)) {
        if (keywordTokens.has(term)) {
          score += 25;
        } else if (keywords.includes(term)) {
          score += 8;
        }
      }
      if (description.includes(term)) {
        score += 4;
      }
      if (category.includes(term)) {
        score += 2;
      }
    }

    if (score > 0) {
      scored.push({ entry, score });
    }
  }

  scored.sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id));

  const results = scored.slice(0, Math.min(limit, ACTIONS_SEARCH_MAX_LIMIT)).map((s) => s.entry);

  return { totalMatches: scored.length, results };
}
