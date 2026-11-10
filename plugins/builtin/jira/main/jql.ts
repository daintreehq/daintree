import type { ListOptions } from "../../../../shared/types/forge.js";

/** Characters Jira refuses inside a JQL string unless they're escaped. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const JQL_ILLEGAL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f￿]+/g;

/** The Lucene syntax behind `~`, plus `"` so a stray quote can't open a phrase. */
const TEXT_RESERVED_CHARACTERS = /[+\-&|!(){}[\]^~*?\\:"/]/g;

/** A JQL string literal. Always used, since a project key can be a reserved word (`ALL`). */
export function quoteJql(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * A `text ~` clause for what someone typed, or `null` when there's nothing in it
 * to search for. Search text is escaped twice over: once for Lucene, which reads
 * the term, and again by {@link quoteJql} for the JQL string around it. The last
 * word matches as a prefix, because the picker searches on each keystroke.
 */
export function textSearchClause(search: string): string | null {
  const cleaned = search.replace(JQL_ILLEGAL_CHARACTERS, " ").trim();
  // Lucene analyses punctuation away, and Jira answers an empty query with a 400.
  if (!/[\p{L}\p{N}]/u.test(cleaned)) return null;
  const terms = cleaned
    // Upper-case, these are Lucene operators, and a lone "OR" is a parse error.
    .replace(/\b(AND|OR|NOT)\b/g, (word) => word.toLowerCase())
    .replace(TEXT_RESERVED_CHARACTERS, "\\$&");
  const query = /[\p{L}\p{N}]$/u.test(cleaned) ? `${terms}*` : terms;
  return `text ~ ${quoteJql(query)}`;
}

function stateClause(state: ListOptions["state"]): string | null {
  if (state === "all") return null;
  if (state === "closed") return `statusCategory = "Done"`;
  // "merged" means nothing for an issue; it reads as the open set (ListOptions).
  return `statusCategory != "Done"`;
}

/** Every clause is bounded by the project: Jira refuses an unbounded search. */
export function issueFilterJql(projectKey: string, state: ListOptions["state"]): string {
  const clause = stateClause(state);
  const project = `project = ${quoteJql(projectKey)}`;
  return clause ? `${project} AND ${clause}` : project;
}

/** An order Jira can't serve is refused by name, never answered in some other order. */
function orderByClause(opts: Pick<ListOptions, "sort" | "direction">): string {
  const sort = opts.sort ?? "created";
  if (sort !== "created" && sort !== "updated") {
    throw new Error(`Jira can't sort issues by "${sort}". Pass sort "created" or "updated".`);
  }
  return `ORDER BY ${sort} ${opts.direction === "asc" ? "ASC" : "DESC"}`;
}

/** The search for a list request, or `null` when its search text can't match anything. */
export function buildIssueJql(projectKey: string, opts: ListOptions): string | null {
  const orderBy = orderByClause(opts);
  const filter = issueFilterJql(projectKey, opts.state);
  const search = opts.search?.trim();
  if (!search) return `${filter} ${orderBy}`;
  const text = textSearchClause(search);
  return text ? `${filter} AND ${text} ${orderBy}` : null;
}

/**
 * The issue key a search names in this project: `ENG-12`, `eng-12`, `12` or
 * `#12`. Another project's key (`DES-12`) names nothing here. `key =` can't serve
 * this in JQL, because Jira fails the whole search with a 400 for a key that
 * doesn't exist, so the caller looks it up on its own.
 */
export function issueKeyInSearch(search: string, projectKey: string): string | null {
  const trimmed = search.trim();
  const number = /^#?(\d+)$/.exec(trimmed)?.[1];
  if (number) return `${projectKey}-${number}`;
  const key = /^([A-Za-z][A-Za-z0-9_]*)-(\d+)$/.exec(trimmed);
  return key && key[1].toUpperCase() === projectKey ? `${projectKey}-${key[2]}` : null;
}
