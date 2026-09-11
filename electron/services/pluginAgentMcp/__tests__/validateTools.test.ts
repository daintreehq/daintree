import { describe, expect, it } from "vitest";
import {
  AGENT_MCP_MAX_DESCRIPTION_BYTES,
  AGENT_MCP_MAX_SCHEMA_BYTES,
  AGENT_MCP_MAX_TOOLS_PER_ENDPOINT,
} from "../../../../shared/types/plugin.js";
import { validateAgentMcpTools } from "../validateTools.js";

function tool(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    description: "Lists transactions.",
    inputSchema: { type: "object", properties: { limit: { type: "number" } } },
    execute: () => null,
    ...overrides,
  };
}

function roster(count: number): Record<string, unknown> {
  const tools: Record<string, unknown> = {};
  for (let i = 0; i < count; i++) tools[`tool_${i}`] = tool();
  return tools;
}

/** A schema whose serialized form is exactly `bytes` long. */
function schemaOfBytes(bytes: number): Record<string, unknown> {
  const overhead = JSON.stringify({ type: "object", description: "" }).length;
  return { type: "object", description: "x".repeat(bytes - overhead) };
}

describe("validateAgentMcpTools", () => {
  it("returns one descriptor per tool, without the execute function", () => {
    const outputSchema = { type: "object", properties: { rows: { type: "array" } } };
    const descriptors = validateAgentMcpTools({
      list_transactions: tool({ outputSchema }),
      summarize: tool({ description: "Totals by month." }),
    });

    expect(descriptors.map((d) => d.name)).toEqual(["list_transactions", "summarize"]);
    expect(descriptors[0].outputSchema).toEqual(outputSchema);
    expect(descriptors[1]).not.toHaveProperty("outputSchema");
    for (const descriptor of descriptors) expect(descriptor).not.toHaveProperty("execute");
  });

  it("detaches advertised schemas from the plugin's objects", () => {
    const inputSchema: Record<string, unknown> = { type: "object", properties: {} };
    const [descriptor] = validateAgentMcpTools({ list: tool({ inputSchema }) });

    // A plugin growing its schema after registration must not grow what agents
    // are shown past the size that was checked.
    inputSchema.properties = { huge: { description: "x".repeat(AGENT_MCP_MAX_SCHEMA_BYTES) } };

    expect(descriptor.inputSchema).toEqual({ type: "object", properties: {} });
    expect(Object.isFrozen(descriptor.inputSchema)).toBe(true);
  });

  it("accepts a full roster and rejects one tool more", () => {
    expect(validateAgentMcpTools(roster(AGENT_MCP_MAX_TOOLS_PER_ENDPOINT))).toHaveLength(
      AGENT_MCP_MAX_TOOLS_PER_ENDPOINT
    );
    expect(() => validateAgentMcpTools(roster(AGENT_MCP_MAX_TOOLS_PER_ENDPOINT + 1))).toThrow(
      /at most/
    );
  });

  it("rejects an empty roster and a non-object roster", () => {
    expect(() => validateAgentMcpTools({})).toThrow(/at least one tool/);
    expect(() => validateAgentMcpTools(null)).toThrow(/plain object/);
    expect(() => validateAgentMcpTools([tool()])).toThrow(/plain object/);
  });

  it.each(["ListTransactions", "1st", "_private", "list-transactions", "a".repeat(49), ""])(
    "rejects the tool name %j",
    (name) => {
      expect(() => validateAgentMcpTools({ [name]: tool() })).toThrow(/must match/);
    }
  );

  it("never serves an inherited key as a tool", () => {
    const inherited = Object.create({ inherited_tool: tool() }) as Record<string, unknown>;
    inherited.own_tool = tool();

    // A roster with a custom prototype is refused outright, so an inherited
    // key can never be mistaken for one the plugin declared.
    expect(() => validateAgentMcpTools(inherited)).toThrow(/plain object/);

    const nullProto = Object.create(null) as Record<string, unknown>;
    nullProto.own_tool = tool();
    expect(validateAgentMcpTools(nullProto).map((d) => d.name)).toEqual(["own_tool"]);
  });

  it("rejects a tool without an execute function", () => {
    expect(() => validateAgentMcpTools({ list: tool({ execute: "run" }) })).toThrow(/execute/);
  });

  it("measures descriptions in UTF-8 bytes, not characters", () => {
    // Three bytes per character: under the limit by length, over it by bytes.
    const multibyte = "€".repeat(Math.floor(AGENT_MCP_MAX_DESCRIPTION_BYTES / 3) + 1);
    expect(multibyte.length).toBeLessThan(AGENT_MCP_MAX_DESCRIPTION_BYTES);

    expect(() => validateAgentMcpTools({ list: tool({ description: multibyte }) })).toThrow(
      /bytes/
    );
    expect(
      validateAgentMcpTools({
        list: tool({ description: "a".repeat(AGENT_MCP_MAX_DESCRIPTION_BYTES) }),
      })
    ).toHaveLength(1);
  });

  it("rejects a blank description", () => {
    expect(() => validateAgentMcpTools({ list: tool({ description: "  " }) })).toThrow(
      /description/
    );
    expect(() => validateAgentMcpTools({ list: tool({ description: 7 }) })).toThrow(/description/);
  });

  it("accepts a schema at the byte limit and rejects one byte over", () => {
    expect(
      validateAgentMcpTools({
        list: tool({ inputSchema: schemaOfBytes(AGENT_MCP_MAX_SCHEMA_BYTES) }),
      })
    ).toHaveLength(1);
    expect(() =>
      validateAgentMcpTools({
        list: tool({ inputSchema: schemaOfBytes(AGENT_MCP_MAX_SCHEMA_BYTES + 1) }),
      })
    ).toThrow(/inputSchema is \d+ bytes/);
    expect(() =>
      validateAgentMcpTools({
        list: tool({ outputSchema: schemaOfBytes(AGENT_MCP_MAX_SCHEMA_BYTES + 1) }),
      })
    ).toThrow(/outputSchema is \d+ bytes/);
  });

  it.each([
    ["a string type", { type: "string" }],
    ["a missing type", { properties: {} }],
    ["an array", [{ type: "object" }]],
    [
      "a class instance",
      new (class Schema {
        type = "object";
      })(),
    ],
  ])("rejects %s as a schema", (_label, schema) => {
    expect(() => validateAgentMcpTools({ list: tool({ inputSchema: schema }) })).toThrow(
      /inputSchema must be a plain object/
    );
    expect(() => validateAgentMcpTools({ list: tool({ outputSchema: schema }) })).toThrow(
      /outputSchema must be a plain object/
    );
  });

  it("checks the serialized schema, which is the one agents are shown", () => {
    const disguised = { type: "object", toJSON: () => ({ type: "array" }) };
    expect(() => validateAgentMcpTools({ list: tool({ inputSchema: disguised }) })).toThrow(
      /must serialize to an object with type "object"/
    );
    const vanishing = { type: "object", toJSON: () => undefined };
    expect(() => validateAgentMcpTools({ list: tool({ inputSchema: vanishing }) })).toThrow(
      /does not serialize to JSON/
    );
  });

  it("returns a frozen roster", () => {
    expect(Object.isFrozen(validateAgentMcpTools({ list: tool() }))).toBe(true);
  });

  it("rejects a schema that cannot be serialized", () => {
    const circular: Record<string, unknown> = { type: "object" };
    circular.self = circular;
    expect(() => validateAgentMcpTools({ list: tool({ inputSchema: circular }) })).toThrow(
      /not JSON-serializable/
    );
  });
});
