import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertPluginActionResult,
  compilePluginActionResultSchema,
} from "../pluginActionResultSchema.js";

const ACTION = "acme.tool.report";

describe("compilePluginActionResultSchema", () => {
  it("resolves references inside the schema", () => {
    const { check } = compilePluginActionResultSchema(ACTION, {
      type: "object",
      $defs: { id: { type: "string", minLength: 1 } },
      properties: { ids: { type: "array", items: { $ref: "#/$defs/id" } } },
    });

    expect(check({ ids: ["a"] })).toBeNull();
    expect(check({ ids: [""] })).not.toBeNull();
  });

  it("compiles a draft-07 schema under draft-07 rules", () => {
    const { check } = compilePluginActionResultSchema(ACTION, {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: { pair: { type: "array", items: [{ type: "string" }, { type: "number" }] } },
    });

    expect(check({ pair: ["a", 1] })).toBeNull();
    expect(check({ pair: [1, "a"] })).not.toBeNull();
  });

  it("enforces a declared format rather than skipping it", () => {
    const { check } = compilePluginActionResultSchema(ACTION, {
      type: "object",
      properties: { at: { type: "string", format: "date-time" } },
    });

    expect(check({ at: "2026-10-23T10:00:00Z" })).toBeNull();
    expect(check({ at: "yesterday" })).not.toBeNull();
  });

  it("refuses a schema that can't cross as JSON", () => {
    const cyclic: Record<string, unknown> = { type: "object" };
    cyclic.properties = { self: cyclic };
    expect(() => compilePluginActionResultSchema(ACTION, cyclic)).toThrow(/JSON-serializable/);

    const disguised = { type: "object", toJSON: () => ({ type: "string" }) };
    expect(() => compilePluginActionResultSchema(ACTION, disguised)).toThrow(/serialize/);
  });

  it("names the action in every refusal", () => {
    for (const raw of [null, [], { type: "string" }, { type: "object", properties: 4 }]) {
      expect(() => compilePluginActionResultSchema(ACTION, raw)).toThrow(
        `Plugin action "${ACTION}" resultSchema`
      );
    }
  });
});

describe("assertPluginActionResult", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lets anything through for an action with no schema", () => {
    expect(() => assertPluginActionResult(ACTION, undefined, "anything")).not.toThrow();
  });

  it("keeps the problem in the log and out of the error the caller gets", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { check } = compilePluginActionResultSchema(ACTION, {
      type: "object",
      additionalProperties: false,
    });

    let thrown: unknown;
    try {
      assertPluginActionResult(ACTION, check, { "/home/someone/notes.txt": 1 });
    } catch (err) {
      thrown = err;
    }

    expect((thrown as { code?: unknown }).code).toBe("RESULT_VALIDATION_ERROR");
    expect((thrown as Error).message).not.toContain("notes.txt");
    expect(String(warn.mock.calls[0]?.[0])).toContain("notes.txt");
  });
});
