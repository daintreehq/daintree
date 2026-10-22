import type { PluginDatabaseQueryContribution } from "../../../shared/types/plugin.js";
import { resolvePluginDatabaseLocation, type PluginDatabaseDeclaration } from "./pluginDatabase.js";
import { runDatabaseToolInProcess } from "../pluginAgentMcp/databaseQueryProcess.js";
import {
  DATABASE_QUERY_TOOL,
  type DatabaseCell,
  type DatabaseQueryResult,
  type DatabaseToolRequest,
} from "../pluginAgentMcp/databaseTools.js";
import {
  bindDeclaredQueryArgs,
  declaredQueryInputSchema,
  declaredQueryPlaceholders,
} from "../pluginAgentMcp/declaredQueries.js";
import { compileAgentMcpSchema } from "../pluginAgentMcp/schemaValidation.js";

export interface DeclarativeSearchRows {
  columns: string[];
  rows: DatabaseCell[][];
}

/** Runs a declarative search provider's query with what the user typed. */
export type DeclarativeSearchRunner = (
  value: string,
  rowLimit: number,
  signal: AbortSignal
) => Promise<DeclarativeSearchRows>;

export interface DeclarativeSearchRunnerOptions {
  declaration: PluginDatabaseDeclaration;
  /** A `mode: "read"` query with exactly one string param; the manifest gate holds it to that. */
  query: PluginDatabaseQueryContribution;
  manifestId: string;
  projectRoot: string | null;
  dataDir: string;
  /** False once this plugin instance has unloaded or been replaced. */
  isCurrent: () => boolean;
  run?: (request: DatabaseToolRequest, signal: AbortSignal) => Promise<unknown>;
}

/**
 * Bind a declarative search provider (#13792) to its declared query. The SQL
 * and the database come from the manifest, never the call, and the statement
 * runs read-only in the same killable child process an agent's declared query
 * does: an expensive statement costs that child when the deadline aborts it,
 * never main. Nothing here starts the plugin.
 *
 * Typed text the param's own constraints refuse, and a database the plugin
 * hasn't created yet, both answer with no rows rather than an error: neither
 * is a fault of the provider.
 */
export function createDeclarativeSearchRunner(
  options: DeclarativeSearchRunnerOptions
): DeclarativeSearchRunner {
  const {
    declaration,
    query,
    manifestId,
    projectRoot,
    dataDir,
    isCurrent,
    run = runDatabaseToolInProcess,
  } = options;
  const placeholders = declaredQueryPlaceholders(query.sql);
  const paramName = Object.keys(query.params)[0] ?? "";
  const check = compileAgentMcpSchema(declaredQueryInputSchema(query.params));

  return async (value, rowLimit, signal) => {
    const args = { [paramName]: value };
    if (check(args) !== null) return { columns: [], rows: [] };
    const params = bindDeclaredQueryArgs(query, placeholders, args);
    let resolved;
    try {
      resolved = await resolvePluginDatabaseLocation({
        declaration,
        manifestId,
        projectRoot,
        dataDir,
        existingOnly: true,
      });
    } catch (error) {
      if ((error as { code?: unknown }).code === "DB_NOT_FOUND") return { columns: [], rows: [] };
      throw error;
    }
    if (!isCurrent()) throw new Error("the plugin unloaded while the search was starting");
    signal.throwIfAborted();
    const result = (await run(
      {
        tool: DATABASE_QUERY_TOOL,
        target: { id: declaration.id, location: declaration.location, resolved, problem: null },
        sql: query.sql,
        params,
        rowLimit,
      },
      signal
    )) as DatabaseQueryResult;
    return { columns: result.columns, rows: result.rows };
  };
}
