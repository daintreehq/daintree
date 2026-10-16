// Declared database queries (`contributes.databases[].queries`): what one must
// be for the host to serve it as an agent tool, and the tool it becomes. Pure,
// so the manifest schema can refuse an unservable query at load, before any
// database exists, with the same reading the endpoint later binds against.

import {
  AGENT_MCP_MAX_SCHEMA_BYTES,
  type PluginDatabaseQueryContribution,
  type PluginDatabaseQueryParam,
  type PluginMcpJsonSchema,
} from "../../../shared/types/plugin.js";
import {
  identifierText,
  isInsignificant,
  lexSql,
  type SqlToken,
} from "../../../shared/utils/sqlLexer.js";

type DeclaredQuery = Pick<PluginDatabaseQueryContribution, "name" | "sql" | "params">;

export interface DeclaredQueryProblem {
  /** The query field the problem is reported against. */
  field: "sql" | "params";
  /** Names the query, since a manifest error is read without its path. */
  message: string;
}

/** The value a declared query binds: an integer or a boolean as a SQLite INTEGER. */
export type DeclaredQueryValue = string | number | bigint;

const READ_STATEMENTS = new Set(["SELECT", "WITH", "VALUES"]);

/**
 * The data-changing statements a `WITH` can end in (and `INSERT OR REPLACE`,
 * `DO UPDATE`). One is refused anywhere in a read query as a bare word, since
 * `WITH x AS (…) DELETE …` begins like a read; a column of the same name has
 * to be quoted. Schema, file and transaction statements need no list: none
 * can sit inside a `SELECT`, so the first-keyword check already refuses them.
 * `REPLACE` followed by `(` is the string function and stays allowed.
 */
const WRITE_KEYWORDS = new Set(["INSERT", "UPDATE", "DELETE", "REPLACE"]);

/**
 * The keyword a bare word spells, folded the way SQLite folds it: ASCII only,
 * so `ınsert` stays a name rather than becoming `INSERT` through Unicode case
 * mapping. A word with any other character is never a keyword.
 */
function keywordOf(token: SqlToken | undefined): string | null {
  if (token?.kind !== "word" || !/^[A-Za-z_]+$/.test(token.text)) return null;
  return token.text.toUpperCase();
}

/** A placeholder the host can bind from a named object. */
const PLACEHOLDER_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const CLOSING_QUOTE: Record<string, string> = { "'": "'", '"': '"', "`": "`", "[": "]" };

/** Whether a string or quoted token reaches its closing delimiter. */
function isClosed(token: SqlToken): boolean {
  const close = CLOSING_QUOTE[token.text[0]!];
  if (close === undefined) return true;
  let i = 1;
  while (i < token.text.length) {
    if (token.text[i] === close) {
      if (close !== "]" && token.text[i + 1] === close) {
        i += 2;
        continue;
      }
      return i === token.text.length - 1;
    }
    i++;
  }
  return false;
}

function splitStatements(tokens: readonly SqlToken[]): SqlToken[][] {
  const statements: SqlToken[][] = [];
  let current: SqlToken[] = [];
  for (const token of tokens) {
    if (token.kind === "semicolon") {
      if (current.length > 0) statements.push(current);
      current = [];
    } else {
      current.push(token);
    }
  }
  if (current.length > 0) statements.push(current);
  return statements;
}

interface PlaceholderScan {
  /** Bare name → the spelling the SQL uses, which is the key its value binds under. */
  spellings: Map<string, string>;
  problems: string[];
}

function scanPlaceholders(tokens: readonly SqlToken[]): PlaceholderScan {
  const spellings = new Map<string, string>();
  const problems: string[] = [];
  let positional = false;
  for (const token of tokens) {
    if (token.kind === "other" && token.text === "?") {
      positional = true;
      continue;
    }
    if (token.kind === "other" && ["$", "@", ":", "#"].includes(token.text)) {
      problems.push(`placeholder ${token.text} has no name`);
      continue;
    }
    if (token.kind !== "variable") continue;
    const name = token.text.slice(1);
    if (token.text.startsWith("#") || !PLACEHOLDER_NAME.test(name)) {
      problems.push(
        `placeholder ${token.text} is not supported; name each one :name, @name or $name with letters, digits and underscores`
      );
      continue;
    }
    const seen = spellings.get(name);
    if (seen === undefined) {
      spellings.set(name, token.text);
    } else if (seen !== token.text) {
      // SQLite reads these as two parameters, and one value cannot bind both.
      problems.push(`placeholder "${name}" is written both as ${seen} and ${token.text}; use one`);
    }
  }
  if (positional) {
    problems.push("positional placeholders (?) are not supported; name each one, e.g. :month");
  }
  return { spellings, problems };
}

function paramSchema(param: PluginDatabaseQueryParam): Record<string, unknown> {
  const base: Record<string, unknown> =
    param.type === "integer"
      ? {
          type: "integer",
          minimum: Number.MIN_SAFE_INTEGER,
          maximum: Number.MAX_SAFE_INTEGER,
        }
      : { type: param.type };
  return param.description !== undefined ? { ...base, description: param.description } : base;
}

/** The tool's input schema: every param, each required, nothing else. */
export function declaredQueryInputSchema(params: DeclaredQuery["params"]): PluginMcpJsonSchema {
  const names = Object.keys(params);
  return {
    type: "object",
    additionalProperties: false,
    properties: Object.fromEntries(names.map((name) => [name, paramSchema(params[name]!)])),
    ...(names.length > 0 ? { required: names } : {}),
  };
}

/**
 * Everything that keeps the host from serving a `"read"` query safely, each
 * message naming the query. The checks are on the SQL as written, since no
 * database need exist at load; the read-only connection the query runs on is
 * what holds at call time.
 */
export function declaredQueryProblems(query: DeclaredQuery): DeclaredQueryProblem[] {
  const problems: DeclaredQueryProblem[] = [];
  const fail = (field: DeclaredQueryProblem["field"], detail: string): void => {
    problems.push({ field, message: `query "${query.name}": ${detail}` });
  };

  const tokens = lexSql(query.sql);
  for (const token of tokens) {
    if ((token.kind === "string" || token.kind === "quoted") && !isClosed(token)) {
      fail("sql", `the SQL has an unterminated ${token.text[0]} quote`);
      return problems;
    }
    if (token.kind === "comment" && token.text.startsWith("/*") && !token.text.endsWith("*/")) {
      fail("sql", "the SQL has an unterminated /* comment");
      return problems;
    }
    // SQLite runs a line comment on past a bare \r, where most editors break
    // the line, so the text after it reads as SQL that never runs.
    if (token.kind === "comment" && token.text.startsWith("--") && /\r\s*\S/.test(token.text)) {
      fail("sql", "a -- comment in the SQL hides text after a bare carriage return");
      return problems;
    }
  }

  const significant = tokens.filter((token) => !isInsignificant(token));
  const statements = splitStatements(significant);
  if (statements.length === 0) {
    fail("sql", "the SQL holds no statement");
    return problems;
  }
  if (statements.length > 1) {
    fail("sql", `the SQL holds ${statements.length} statements; a query is exactly one`);
    return problems;
  }

  const statement = statements[0]!;
  const first = statement[0]!;
  if (!READ_STATEMENTS.has(keywordOf(first) ?? "")) {
    fail(
      "sql",
      `a "read" query must be one SELECT, WITH or VALUES statement, not one starting ${first.text}`
    );
    return problems;
  }
  const write = statement.find(
    (token, index) =>
      WRITE_KEYWORDS.has(keywordOf(token) ?? "") &&
      !(keywordOf(token) === "REPLACE" && statement[index + 1]?.text === "(")
  );
  if (write) {
    fail(
      "sql",
      `a "read" query cannot contain ${keywordOf(write)}; quote a column or table of that name`
    );
    return problems;
  }
  // Quoted too: SQLite calls `"load_extension"(…)` all the same.
  const extension = statement.findIndex(
    (token, index) =>
      identifierText(token) === "load_extension" && statement[index + 1]?.text === "("
  );
  if (extension >= 0) {
    fail("sql", "a query cannot call load_extension()");
    return problems;
  }

  const { spellings, problems: placeholderProblems } = scanPlaceholders(statement);
  for (const problem of placeholderProblems) fail("sql", problem);
  if (placeholderProblems.length > 0) return problems;

  for (const [name, spelling] of spellings) {
    if (!Object.hasOwn(query.params, name)) {
      fail("params", `placeholder ${spelling} has no param "${name}" declared for it`);
    }
  }
  for (const name of Object.keys(query.params)) {
    if (!spellings.has(name)) fail("params", `param "${name}" has no placeholder in the SQL`);
  }
  if (problems.length > 0) return problems;

  const schemaBytes = new TextEncoder().encode(
    JSON.stringify(declaredQueryInputSchema(query.params))
  ).length;
  if (schemaBytes > AGENT_MCP_MAX_SCHEMA_BYTES) {
    fail(
      "params",
      `its params make a ${schemaBytes}-byte input schema; the limit is ${AGENT_MCP_MAX_SCHEMA_BYTES}`
    );
  }
  return problems;
}

/**
 * The spelling of each placeholder, keyed by bare name, for a query that
 * passed {@link declaredQueryProblems}. Values are bound under exactly these
 * keys, so the SQL decides which of `:`, `@` or `$` a param answers to.
 */
export function declaredQueryPlaceholders(sql: string): ReadonlyMap<string, string> {
  const significant = lexSql(sql).filter((token) => !isInsignificant(token));
  return scanPlaceholders(significant).spellings;
}

/**
 * Agent arguments, already checked against {@link declaredQueryInputSchema},
 * as the values the statement binds. Integers and booleans go in as BigInt so
 * SQLite reads an INTEGER: a JavaScript number always binds as a REAL, which
 * would print as `5.0` in a string.
 */
export function bindDeclaredQueryArgs(
  query: DeclaredQuery,
  placeholders: ReadonlyMap<string, string>,
  args: Readonly<Record<string, unknown>>
): Record<string, DeclaredQueryValue> {
  const bound: Record<string, DeclaredQueryValue> = {};
  for (const [name, spelling] of placeholders) {
    const value = args[name];
    const type = query.params[name]?.type;
    if (type === "boolean" && typeof value === "boolean") {
      bound[spelling] = value ? 1n : 0n;
    } else if (type === "integer" && Number.isSafeInteger(value)) {
      bound[spelling] = BigInt(value as number);
    } else if (
      (type === "number" && typeof value === "number") ||
      (type === "string" && typeof value === "string")
    ) {
      bound[spelling] = value;
    } else {
      throw new Error(
        `query "${query.name}" param "${name}" must be a ${type ?? "declared"} value`
      );
    }
  }
  return bound;
}

/**
 * What an agent is shown. Read-only by the host's own reading of the SQL and
 * the connection it runs on; the declaration's `mode` picks the access level
 * and is never advertised.
 */
export function declaredQueryDescriptor(
  query: Pick<PluginDatabaseQueryContribution, "name" | "description" | "params">
): { name: string; description: string; inputSchema: PluginMcpJsonSchema; readOnly: true } {
  return {
    name: query.name,
    description: query.description,
    inputSchema: declaredQueryInputSchema(query.params),
    readOnly: true,
  };
}
