// The host's read-only database tools for agents: what they advertise, and the
// work each call does. The work runs in a short-lived utility process
// (databaseQueryWorker.ts), so this module stays free of Electron imports.

import {
  AGENT_MCP_MAX_RESULT_BYTES,
  type PluginDatabaseLocation,
  type PluginMcpJsonSchema,
} from "../../../shared/types/plugin.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { readPluginDatabaseRows } from "../../../shared/utils/pluginDatabaseHandle.js";

export const DATABASE_SCHEMA_TOOL = "database_schema";
export const DATABASE_QUERY_TOOL = "database_query";

export const DATABASE_QUERY_DEFAULT_ROWS = 100;
export const DATABASE_QUERY_MAX_ROWS = 1000;
/** Most schema objects listed per database. */
export const DATABASE_SCHEMA_MAX_OBJECTS = 1000;
/**
 * Budget for returned data: the session server refuses a result over
 * {@link AGENT_MCP_MAX_RESULT_BYTES}, so stop well short and leave room for the
 * envelope around the rows.
 */
export const DATABASE_RESULT_BUDGET_BYTES = AGENT_MCP_MAX_RESULT_BYTES - 8 * 1024;

const DATABASE_ID_SCHEMA = {
  type: "string",
  minLength: 1,
  maxLength: 64,
  pattern: "^[a-zA-Z0-9._-]+$",
} as const;

const PARAMETER_SCHEMA = { type: ["string", "number", "null"] } as const;

export const DATABASE_TOOL_DESCRIPTORS: ReadonlyArray<{
  name: string;
  description: string;
  inputSchema: PluginMcpJsonSchema;
}> = [
  {
    name: DATABASE_SCHEMA_TOOL,
    description:
      "List this plugin's declared SQLite databases and the CREATE statements of their tables, views, indexes and triggers. Pass databaseId to show one. A database that does not exist yet is reported, never created.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { databaseId: DATABASE_ID_SCHEMA },
    },
  },
  {
    name: DATABASE_QUERY_TOOL,
    description:
      "Run one read-only SQL statement that returns rows (SELECT, WITH, or a PRAGMA such as table_info) against a declared database. Bind values with ? and a params array, or :name and a params object. Rows are arrays aligned with columns; blobs are base64. truncated is true when rows were cut off.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["databaseId", "sql"],
      properties: {
        databaseId: DATABASE_ID_SCHEMA,
        sql: { type: "string", minLength: 1, maxLength: 65536 },
        params: {
          anyOf: [
            { type: "array", maxItems: 128, items: PARAMETER_SCHEMA },
            {
              type: "object",
              maxProperties: 128,
              propertyNames: { pattern: "^[:@$][A-Za-z_][A-Za-z0-9_]*$" },
              additionalProperties: PARAMETER_SCHEMA,
            },
          ],
        },
        rowLimit: { type: "integer", minimum: 1, maximum: DATABASE_QUERY_MAX_ROWS },
      },
    },
  },
];

/**
 * One declared database as main resolved it for a call. `location` is null
 * when it could not be resolved; `problem` then says why (`DB_NOT_FOUND` for a
 * database the plugin has not created yet).
 */
export interface DatabaseTarget {
  id: string;
  location: "project" | "local";
  description?: string;
  resolved: PluginDatabaseLocation | null;
  problem: { code: string; message: string } | null;
}

type DatabaseQueryParam = string | number | null;
export type DatabaseQueryParams = DatabaseQueryParam[] | Record<string, DatabaseQueryParam>;

export type DatabaseToolRequest =
  | { tool: typeof DATABASE_SCHEMA_TOOL; targets: DatabaseTarget[] }
  | {
      tool: typeof DATABASE_QUERY_TOOL;
      target: DatabaseTarget;
      sql: string;
      params?: DatabaseQueryParams;
      rowLimit?: number;
    };

export type DatabaseToolResponse =
  { ok: true; value: unknown } | { ok: false; error: { code: string | null; message: string } };

export interface DatabaseSchemaObject {
  type: string;
  name: string;
  tableName: string;
  sql: string | null;
}

export interface DatabaseSchemaEntry {
  id: string;
  location: "project" | "local";
  description?: string;
  exists: boolean | null;
  objects: DatabaseSchemaObject[];
  truncated: boolean;
  error: { code: string; message: string } | null;
}

export type DatabaseCell = string | number | null | { blob: string };

export interface DatabaseQueryResult {
  databaseId: string;
  columns: string[];
  rows: DatabaseCell[][];
  truncated: boolean;
}

function errorCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

function errorMessage(error: unknown): string {
  return formatErrorMessage(error, "database query failed");
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/**
 * A value as JSON can carry it. Integers past 2^53 become decimal strings
 * rather than rounding, and a blob is base64 under a `blob` key so it cannot
 * be mistaken for text.
 */
export function encodeCell(value: unknown): DatabaseCell {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") {
    return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return { blob: Buffer.from(value).toString("base64") };
  return String(value);
}

function unavailable(target: DatabaseTarget): Error {
  const problem = target.problem ?? {
    code: "DB_UNAVAILABLE",
    message: `database "${target.id}" is unavailable`,
  };
  const error = new Error(`${problem.code}: ${problem.message}`) as Error & { code: string };
  error.code = problem.code;
  return error;
}

const SCHEMA_SQL =
  "SELECT type, name, tbl_name, sql FROM main.sqlite_schema WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'view' THEN 1 WHEN 'index' THEN 2 ELSE 3 END, name";

export function runDatabaseSchema(
  targets: readonly DatabaseTarget[],
  budgetBytes: number = DATABASE_RESULT_BUDGET_BYTES
): { databases: DatabaseSchemaEntry[]; truncated: boolean } {
  const databases: DatabaseSchemaEntry[] = targets.map((target) => ({
    id: target.id,
    location: target.location,
    ...(target.description !== undefined ? { description: target.description } : {}),
    exists: target.resolved ? true : target.problem?.code === "DB_NOT_FOUND" ? false : null,
    objects: [],
    truncated: false,
    error: target.resolved || target.problem?.code === "DB_NOT_FOUND" ? null : target.problem,
  }));
  // Every database's entry is paid for first, so running out of budget drops
  // DDL, never the fact that a database exists.
  let used = jsonBytes({ databases, truncated: false });
  let truncated = false;
  targets.forEach((target, index) => {
    const entry = databases[index]!;
    if (!target.resolved) return;
    if (truncated) {
      entry.truncated = true;
      return;
    }
    try {
      readPluginDatabaseRows(target.resolved, SCHEMA_SQL, undefined, (row) => {
        const [type, name, tableName, sql] = row;
        const object: DatabaseSchemaObject = {
          type: String(type),
          name: String(name),
          tableName: String(tableName),
          sql: typeof sql === "string" ? sql : null,
        };
        const cost = jsonBytes(object) + 1;
        if (entry.objects.length >= DATABASE_SCHEMA_MAX_OBJECTS || used + cost > budgetBytes) {
          entry.truncated = true;
          truncated = true;
          return false;
        }
        used += cost;
        entry.objects.push(object);
        return true;
      });
    } catch (error) {
      if (errorCode(error) === "DB_NOT_FOUND") {
        entry.exists = false;
        return;
      }
      entry.exists = null;
      const detail = { code: errorCode(error) ?? "DB_ERROR", message: errorMessage(error) };
      const cost = jsonBytes(detail);
      if (used + cost <= budgetBytes) {
        entry.error = detail;
        used += cost;
      } else {
        entry.error = { code: detail.code, message: "" };
      }
    }
  });
  return { databases, truncated };
}

export function runDatabaseQuery(
  request: Extract<DatabaseToolRequest, { tool: typeof DATABASE_QUERY_TOOL }>,
  budgetBytes: number = DATABASE_RESULT_BUDGET_BYTES
): DatabaseQueryResult {
  const { target, sql, params } = request;
  if (!target.resolved) throw unavailable(target);
  const rowLimit = Math.min(
    Math.max(1, Math.trunc(request.rowLimit ?? DATABASE_QUERY_DEFAULT_ROWS)),
    DATABASE_QUERY_MAX_ROWS
  );
  const rows: DatabaseCell[][] = [];
  let truncated = false;
  let used = 0;
  const { columns } = readPluginDatabaseRows(target.resolved, sql, params, (row) => {
    if (rows.length >= rowLimit) {
      truncated = true;
      return false;
    }
    const encoded = row.map(encodeCell);
    const cost = jsonBytes(encoded) + 1;
    if (used + cost > budgetBytes) {
      truncated = true;
      return false;
    }
    used += cost;
    rows.push(encoded);
    return true;
  });
  const result: DatabaseQueryResult = { databaseId: target.id, columns, rows, truncated };
  // Column names count too; a statement with thousands of long aliases is the
  // one case trimming rows cannot fix.
  while (rows.length > 0 && jsonBytes(result) > budgetBytes) {
    rows.pop();
    result.truncated = true;
  }
  if (jsonBytes(result) > budgetBytes) {
    const error = new Error(
      "DB_RESULT_TOO_LARGE: the statement's column list alone is over the result limit"
    ) as Error & { code: string };
    error.code = "DB_RESULT_TOO_LARGE";
    throw error;
  }
  return result;
}

export function runDatabaseTool(request: DatabaseToolRequest): DatabaseToolResponse {
  try {
    const value =
      request.tool === DATABASE_SCHEMA_TOOL
        ? runDatabaseSchema(request.targets)
        : runDatabaseQuery(request);
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: { code: errorCode(error), message: errorMessage(error) } };
  }
}
