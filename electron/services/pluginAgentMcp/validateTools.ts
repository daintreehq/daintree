import {
  AGENT_MCP_MAX_DESCRIPTION_BYTES,
  AGENT_MCP_MAX_SCHEMA_BYTES,
  AGENT_MCP_MAX_TOOLS_PER_ENDPOINT,
  AGENT_MCP_TOOL_NAME_PATTERN,
  type PluginMcpJsonSchema,
  type PluginMcpToolAnnotations,
} from "../../../shared/types/plugin.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { compileAgentMcpSchema, type AgentMcpSchemaCheck } from "./schemaValidation.js";
import {
  RESERVED_AGENT_MCP_TOOL_NAMES,
  type AgentMcpRegisteredTool,
  type AgentMcpToolDescriptor,
} from "./types.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/**
 * Measure a schema and take the copy the host will advertise. The copy is the
 * re-parse of the very string that was measured, so a plugin mutating its own
 * schema object after registration can neither grow the advertised schema past
 * the budget nor make it disagree with what was checked.
 */
function snapshotSchema(toolName: string, field: string, schema: unknown): PluginMcpJsonSchema {
  if (!isPlainObject(schema) || schema.type !== "object") {
    throw new Error(`tool "${toolName}" ${field} must be a plain object with type "object"`);
  }
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(schema);
  } catch (err) {
    throw new Error(
      `tool "${toolName}" ${field} is not JSON-serializable: ${formatErrorMessage(err, "serialization failed")}`,
      { cause: err }
    );
  }
  if (serialized === undefined) {
    throw new Error(`tool "${toolName}" ${field} does not serialize to JSON`);
  }
  const bytes = utf8Bytes(serialized);
  if (bytes > AGENT_MCP_MAX_SCHEMA_BYTES) {
    throw new Error(
      `tool "${toolName}" ${field} is ${bytes} bytes serialized; the limit is ${AGENT_MCP_MAX_SCHEMA_BYTES}`
    );
  }
  // Checked again on the parsed copy, because that copy is what gets
  // advertised: a `toJSON` can serialize an object schema into anything else.
  const snapshot: unknown = JSON.parse(serialized);
  if (!isPlainObject(snapshot) || snapshot.type !== "object") {
    throw new Error(`tool "${toolName}" ${field} must serialize to an object with type "object"`);
  }
  return deepFreeze(snapshot as PluginMcpJsonSchema);
}

const ANNOTATION_KEYS = ["destructiveHint", "idempotentHint", "openWorldHint"] as const;

/**
 * A read-only claim is the one hint that lets a client skip its approval
 * prompt, so a plugin may not make it about its own tool. Rejected rather than
 * dropped, so an author is never left believing the claim was advertised.
 */
const READ_ONLY_KEYS = ["readOnly", "readOnlyHint"] as const;

function rejectReadOnlyClaim(
  toolName: string,
  where: string,
  value: Record<string, unknown>
): void {
  for (const key of READ_ONLY_KEYS) {
    if (Object.hasOwn(value, key)) {
      throw new Error(
        `tool "${toolName}" ${where}${key} is not allowed: only the host may mark a tool read-only`
      );
    }
  }
}

/** Check a tool's declared annotations and take a frozen copy of the ones it set. */
function snapshotAnnotations(
  toolName: string,
  annotations: unknown
): Readonly<PluginMcpToolAnnotations> | undefined {
  if (annotations === undefined) return undefined;
  if (!isPlainObject(annotations)) {
    throw new Error(`tool "${toolName}" annotations must be a plain object`);
  }
  rejectReadOnlyClaim(toolName, "annotations.", annotations);
  const snapshot: { -readonly [K in keyof PluginMcpToolAnnotations]: boolean } = {};
  for (const key of Object.keys(annotations)) {
    if (!(ANNOTATION_KEYS as readonly string[]).includes(key)) {
      throw new Error(
        `tool "${toolName}" annotations.${key} is not supported; allowed: ${ANNOTATION_KEYS.join(", ")}`
      );
    }
    const value = annotations[key];
    if (value === undefined) continue;
    if (typeof value !== "boolean") {
      throw new Error(`tool "${toolName}" annotations.${key} must be a boolean`);
    }
    snapshot[key as (typeof ANNOTATION_KEYS)[number]] = value;
  }
  return Object.keys(snapshot).length > 0 ? Object.freeze(snapshot) : undefined;
}

function compileSchema(
  toolName: string,
  field: string,
  schema: PluginMcpJsonSchema
): AgentMcpSchemaCheck {
  try {
    return compileAgentMcpSchema(schema);
  } catch (err) {
    throw new Error(
      `tool "${toolName}" ${field} ${formatErrorMessage(err, "cannot be compiled")}`,
      {
        cause: err,
      }
    );
  }
}

/**
 * Compile a descriptor's schemas into the checks dispatch runs on every call
 * and every structured result. Throws when a schema cannot be enforced as
 * written — invalid, referring outside itself, async, or naming an unknown
 * format — because advertising a contract the host would not keep is worse
 * than refusing the roster.
 */
export function compileAgentMcpTool(descriptor: AgentMcpToolDescriptor): AgentMcpRegisteredTool {
  const { name, description, inputSchema, outputSchema, readOnly, annotations } = descriptor;
  const checkInput = compileSchema(name, "inputSchema", inputSchema);
  const flags = {
    ...(readOnly === true ? { readOnly } : {}),
    ...(annotations !== undefined ? { annotations } : {}),
  };
  if (outputSchema === undefined) {
    return Object.freeze({ name, description, inputSchema, checkInput, ...flags });
  }
  const checkOutput = compileSchema(name, "outputSchema", outputSchema);
  return Object.freeze({
    name,
    description,
    inputSchema,
    outputSchema,
    checkInput,
    checkOutput,
    ...flags,
  });
}

/**
 * Check a `host.mcp.registerTools` roster against the endpoint budget and
 * return the agent-facing descriptors, frozen and detached from the plugin's
 * objects, with their schemas compiled. Throws on the first violation — a
 * roster is accepted or rejected whole, never trimmed, so an agent is never
 * shown a partial inventory the plugin did not intend.
 *
 * Only what an agent sees is checked here. The manifest gates (`mcp:expose`,
 * the endpoint declared in `contributes.agentMcp`) belong to the host that knows
 * which plugin is registering.
 */
export function validateAgentMcpTools(tools: unknown): readonly AgentMcpRegisteredTool[] {
  if (!isPlainObject(tools)) {
    throw new Error("tools must be a plain object keyed by tool name");
  }
  // Own enumerable keys only: an inherited property is not something the plugin
  // put in its roster, and serving it would advertise a tool nobody declared.
  const names = Object.keys(tools);
  if (names.length === 0) {
    throw new Error("tools must register at least one tool");
  }
  if (names.length > AGENT_MCP_MAX_TOOLS_PER_ENDPOINT) {
    throw new Error(
      `tools registers ${names.length} tools; an endpoint may register at most ${AGENT_MCP_MAX_TOOLS_PER_ENDPOINT}`
    );
  }
  const descriptors: AgentMcpToolDescriptor[] = [];
  for (const name of names) {
    if (!AGENT_MCP_TOOL_NAME_PATTERN.test(name)) {
      throw new Error(
        `tool name "${name}" must match ${String(AGENT_MCP_TOOL_NAME_PATTERN)} (lowercase letters, digits and underscores, starting with a letter)`
      );
    }
    if (RESERVED_AGENT_MCP_TOOL_NAMES.has(name)) {
      throw new Error(
        `tool name "${name}" is reserved for the host's database tools, which share this plugin's MCP server`
      );
    }
    const definition = tools[name];
    if (!isPlainObject(definition)) {
      throw new Error(`tool "${name}" must be an object`);
    }
    if (typeof definition.execute !== "function") {
      throw new Error(`tool "${name}" must provide an execute() function`);
    }
    const { description } = definition;
    if (typeof description !== "string" || description.trim().length === 0) {
      throw new Error(`tool "${name}" description must be a non-empty string`);
    }
    const descriptionBytes = utf8Bytes(description);
    if (descriptionBytes > AGENT_MCP_MAX_DESCRIPTION_BYTES) {
      throw new Error(
        `tool "${name}" description is ${descriptionBytes} bytes; the limit is ${AGENT_MCP_MAX_DESCRIPTION_BYTES}`
      );
    }
    rejectReadOnlyClaim(name, "", definition);
    const annotations = snapshotAnnotations(name, definition.annotations);
    const inputSchema = snapshotSchema(name, "inputSchema", definition.inputSchema);
    const outputSchema =
      definition.outputSchema === undefined
        ? undefined
        : snapshotSchema(name, "outputSchema", definition.outputSchema);
    descriptors.push({
      name,
      description,
      inputSchema,
      ...(outputSchema !== undefined ? { outputSchema } : {}),
      ...(annotations !== undefined ? { annotations } : {}),
    });
  }
  // Compiled only once every cheap check has passed, so a roster that is
  // rejected anyway costs no compilation.
  return Object.freeze(descriptors.map(compileAgentMcpTool));
}
