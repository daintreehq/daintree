import {
  AGENT_MCP_MAX_DESCRIPTION_BYTES,
  AGENT_MCP_MAX_SCHEMA_BYTES,
  AGENT_MCP_MAX_TOOLS_PER_ENDPOINT,
  AGENT_MCP_TOOL_NAME_PATTERN,
  type PluginMcpJsonSchema,
} from "../../../shared/types/plugin.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import type { AgentMcpToolDescriptor } from "./types.js";

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

/**
 * Check a `host.mcp.registerTools` roster against the endpoint budget and
 * return the agent-facing descriptors, frozen and detached from the plugin's
 * objects. Throws on the first violation — a roster is accepted or rejected
 * whole, never trimmed, so an agent is never shown a partial inventory the
 * plugin did not intend.
 *
 * Only what an agent sees is checked here. The manifest gates (`mcp:expose`,
 * the endpoint declared in `contributes.agentMcp`) belong to the host that knows
 * which plugin is registering.
 */
export function validateAgentMcpTools(tools: unknown): readonly AgentMcpToolDescriptor[] {
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
    const inputSchema = snapshotSchema(name, "inputSchema", definition.inputSchema);
    const outputSchema =
      definition.outputSchema === undefined
        ? undefined
        : snapshotSchema(name, "outputSchema", definition.outputSchema);
    descriptors.push(
      Object.freeze({
        name,
        description,
        inputSchema,
        ...(outputSchema !== undefined ? { outputSchema } : {}),
      })
    );
  }
  return Object.freeze(descriptors);
}
