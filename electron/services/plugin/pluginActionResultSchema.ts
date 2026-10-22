import type { PluginActionResultSchema } from "../../../shared/types/plugin.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { AppError } from "../../utils/errorTypes.js";
import {
  compileAgentMcpSchema,
  type AgentMcpSchemaCheck,
} from "../pluginAgentMcp/schemaValidation.js";

/** `null` when a result conforms; otherwise why it does not. Never throws. */
export type PluginActionResultCheck = AgentMcpSchemaCheck;

export interface CompiledPluginActionResultSchema {
  /** The host's own copy: what the catalog and MCP publish. */
  schema: PluginActionResultSchema;
  /** Compiled from that same copy, so the published and enforced contracts agree. */
  check: PluginActionResultCheck;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * Take the host's copy of an action's declared result schema and compile it,
 * or throw saying why it can't be enforced as written. Uses the compiler the
 * agent MCP rosters use, so a plugin's two kinds of output schema follow one
 * set of rules: 2020-12 unless `$schema` names draft-07, references only inside
 * the schema, no `$async`, and results checked as sent.
 *
 * The copy is a JSON re-parse, so a plugin that mutates its own object after
 * registering (an in-process builtin holds the reference) can't make the
 * schema callers see disagree with the one dispatch enforces.
 */
export function compilePluginActionResultSchema(
  actionId: string,
  raw: unknown
): CompiledPluginActionResultSchema {
  const what = `Plugin action "${actionId}" resultSchema`;
  if (!isPlainObject(raw) || raw.type !== "object") {
    throw new Error(`${what} must be a plain object with type "object"`);
  }
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(JSON.stringify(raw));
  } catch (err) {
    throw new Error(
      `${what} is not JSON-serializable: ${formatErrorMessage(err, "serialization failed")}`,
      { cause: err }
    );
  }
  // Checked again on the copy: a `toJSON` can serialize an object into anything.
  if (!isPlainObject(snapshot) || snapshot.type !== "object") {
    throw new Error(`${what} must serialize to an object with type "object"`);
  }
  const schema = snapshot as PluginActionResultSchema;
  try {
    return { schema, check: compileAgentMcpSchema(schema) };
  } catch (err) {
    throw new Error(`${what} ${formatErrorMessage(err, "cannot be compiled")}`, { cause: err });
  }
}

/**
 * Hold a plugin action's result to its declared schema. The problem description
 * names paths and keys taken from the result itself, so it stays in the main
 * log; what the caller receives names only the action.
 */
export function assertPluginActionResult(
  actionId: string,
  check: PluginActionResultCheck | undefined,
  result: unknown
): void {
  if (!check) return;
  const problem = check(result);
  if (problem === null) return;
  console.warn(
    `[PluginService] Action "${actionId}" returned a result its resultSchema rejects: ${problem}`
  );
  throw new AppError({
    code: "RESULT_VALIDATION_ERROR",
    message: `Plugin action "${actionId}" returned a result that does not match its declared resultSchema`,
  });
}
