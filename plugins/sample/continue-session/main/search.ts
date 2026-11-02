import type { PluginMcpCaller, PluginMcpToolDefinition } from "../../../../shared/types/plugin.js";
import type { Catalog, ConversionRecord } from "./catalog.js";
import { AGENT_LABELS } from "./handoff.js";
import type { IndexStore, SearchHit } from "./indexStore.js";

const QUERY_MAX_CHARS = 500;
const MAX_TERMS = 16;
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 25;
/** Sessions searched in one call when the caller can see several. */
const MAX_SESSIONS = 10;

/**
 * Who may search a converted session. By default only the agent launched to
 * continue it: the caller's credential was minted for that terminal in that
 * project. A project that shares its converted sessions lets every agent in
 * it search them, and its agents can also search the sessions of every other
 * project that shares; a project that doesn't share is never searched from
 * outside, whatever another project has turned on.
 *
 * `caller` is the host's provenance of the credential, never anything the
 * agent sent.
 */
export function canSearch(
  record: ConversionRecord,
  caller: Pick<PluginMcpCaller, "projectId" | "terminalId">,
  sharedProjects: ReadonlySet<string>
): boolean {
  if (record.projectId === caller.projectId && record.terminalId === caller.terminalId) {
    return true;
  }
  return sharedProjects.has(caller.projectId) && sharedProjects.has(record.projectId);
}

/**
 * An FTS5 MATCH expression built from plain words, never passed through: FTS5
 * query syntax (`NEAR`, `*`, column filters, unbalanced quotes) is not the
 * agent's to write, and a stray operator would fail the query. Quoted phrases
 * stay phrases, and so does an identifier the tokenizer splits (`VOICE_KEY`,
 * `src/keys.ts`), so it matches as written rather than as loose words.
 */
export function buildMatch(query: string, mode: "all" | "any"): string | null {
  const text = query.slice(0, QUERY_MAX_CHARS);
  const terms: string[] = [];
  const phrasePattern = /"([^"]*)"/g;
  for (const match of text.matchAll(phrasePattern)) {
    const words = wordsOf(match[1] ?? "");
    if (words.length > 0) terms.push(`"${words.join(" ")}"`);
  }
  for (const token of text.replace(phrasePattern, " ").split(/\s+/)) {
    const words = wordsOf(token);
    if (words.length > 0) terms.push(`"${words.join(" ")}"`);
  }
  const unique = [...new Set(terms)].slice(0, MAX_TERMS);
  if (unique.length === 0) return null;
  return unique.join(mode === "all" ? " AND " : " OR ");
}

function wordsOf(text: string): string[] {
  return (text.match(/[\p{L}\p{N}]+/gu) ?? []).map((word) => word.slice(0, 64));
}

export interface SearchedSession {
  readonly convertedSessionId: string;
  readonly sourceAgent: string;
  readonly sourceSessionId: string;
  readonly sessionFile: string;
  readonly convertedAt: string;
  readonly matched: "all words" | "any word";
  readonly hits: readonly SearchHit[];
}

export function createSearchTool(deps: {
  catalog: Catalog;
  store: IndexStore;
  log: (message: string) => void;
}): PluginMcpToolDefinition {
  return {
    description:
      "Search a Codex or Claude Code session this agent continues, converted by Daintree into a local index. Returns ranked excerpts ([match] marked) with each record's line and byte offset in the session file. Plain words; quote a phrase.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: QUERY_MAX_CHARS },
        limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT },
        convertedSessionId: { type: "string", maxLength: 64 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async execute(args, caller, signal) {
      const query = typeof args.query === "string" ? args.query : "";
      const limit = typeof args.limit === "number" ? args.limit : DEFAULT_LIMIT;
      const only = typeof args.convertedSessionId === "string" ? args.convertedSessionId : null;

      const [records, shared] = await Promise.all([
        deps.catalog.list(),
        deps.catalog.sharedProjects(),
      ]);
      const visible = records
        .filter((record) => canSearch(record, caller, shared))
        .filter((record) => only === null || record.id === only)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, MAX_SESSIONS);
      if (visible.length === 0) {
        throw new Error(
          only === null
            ? "No converted session is searchable from this agent. Only the agent launched to continue a session can search it, unless its project shares converted sessions."
            : `Converted session ${only} doesn't exist or isn't searchable from this agent.`
        );
      }

      const all = buildMatch(query, "all");
      if (!all) throw new Error("The query has no words to search for.");
      const any = buildMatch(query, "any");
      const sessions: SearchedSession[] = [];
      for (const record of visible) {
        signal.throwIfAborted();
        let hits = runSearch(deps, record, all, limit);
        let matched: SearchedSession["matched"] = "all words";
        if (hits.length === 0 && any && any !== all) {
          hits = runSearch(deps, record, any, limit);
          matched = "any word";
        }
        sessions.push({
          convertedSessionId: record.id,
          sourceAgent: AGENT_LABELS[record.sourceAgent],
          sourceSessionId: record.sourceSessionId,
          sessionFile: record.sourcePath,
          convertedAt: new Date(record.createdAt).toISOString(),
          matched,
          hits,
        });
      }
      return { sessions };
    },
  };
}

function runSearch(
  deps: { store: IndexStore; log: (message: string) => void },
  record: ConversionRecord,
  match: string,
  limit: number
): SearchHit[] {
  try {
    return deps.store.search(record.id, match, limit);
  } catch (error) {
    // Never the query: it can quote the session.
    deps.log(`search failed for ${record.id}: ${error instanceof Error ? error.name : "error"}`);
    throw new Error(
      `Converted session ${record.id} couldn't be searched: its index is missing or damaged. Convert the session again from its pane's menu.`
    );
  }
}
