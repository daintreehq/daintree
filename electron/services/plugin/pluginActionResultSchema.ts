import type { PluginActionResultSchema } from "../../../shared/types/plugin.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { AppError } from "../../utils/errorTypes.js";
import { PluginPayloadTooLargeError } from "./pluginPayloadLimits.js";
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

class JsonBudgetExceeded extends Error {}

/**
 * `JSON.stringify`, abandoned once the output is sure to pass `maxBytes`. The
 * structured-clone estimate that runs first counts a shared object once, while
 * JSON writes it out at every reference, so without a running count one large
 * value referenced from many keys would expand far past the cap in main. Each
 * visit subtracts no more than it adds to the output, so a stop is never early.
 */
function stringifyWithin(value: unknown, maxBytes: number): string | undefined {
  let remaining = maxBytes;
  return JSON.stringify(value, (key, child: unknown) => {
    remaining -= key.length + (typeof child === "string" ? child.length : 1);
    if (remaining < 0) throw new JsonBudgetExceeded();
    return child;
  });
}

/**
 * Hold a plugin action's result to its declared schema and return what the
 * caller receives. An action without a schema gets its result back untouched.
 *
 * With one, the check runs on the result's JSON form and that same copy is what
 * goes back: a JSON Schema describes JSON, and the agent MCP path sends JSON,
 * so checking the live value would let a `Date` pass as an object here and
 * reach an agent as a string its schema refuses. A structured-clone caller then
 * receives exactly what was checked, too. The copy is held to `maxBytes` as
 * well, since it can be larger than the value the size check measured.
 *
 * The problem description names paths and keys taken from the result itself,
 * so it stays in the main log; what the caller receives names only the action.
 */
export function enforcePluginActionResult(
  pluginId: string,
  actionId: string,
  check: PluginActionResultCheck | undefined,
  result: unknown,
  maxBytes: number
): unknown {
  if (!check) return result;
  const what = `result of "${actionId}"`;
  let delivered: unknown;
  let problem: string | null;
  try {
    const text = stringifyWithin(result, maxBytes);
    if (text !== undefined) {
      const bytes = Buffer.byteLength(text, "utf8");
      if (bytes > maxBytes) throw new PluginPayloadTooLargeError(pluginId, what, maxBytes, bytes);
    }
    delivered = text === undefined ? undefined : JSON.parse(text);
    problem = check(delivered);
  } catch (err) {
    if (err instanceof PluginPayloadTooLargeError) throw err;
    if (err instanceof JsonBudgetExceeded) {
      throw new PluginPayloadTooLargeError(pluginId, `${what} as JSON`, maxBytes);
    }
    problem = `is not JSON-serializable: ${formatErrorMessage(err, "serialization failed")}`;
  }
  if (problem === null) return delivered;
  console.warn(
    `[PluginService] Action "${actionId}" returned a result its resultSchema rejects: ${problem}`
  );
  throw new AppError({
    code: "RESULT_VALIDATION_ERROR",
    message: `Plugin action "${actionId}" returned a result that does not match its declared resultSchema`,
  });
}
