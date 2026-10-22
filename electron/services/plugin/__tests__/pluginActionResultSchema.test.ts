import { afterEach, describe, expect, it, vi } from "vitest";
import {
  compilePluginActionResultSchema,
  enforcePluginActionResult,
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

describe("enforcePluginActionResult", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const rejection = (fn: () => unknown): { code?: unknown; message: string } | null => {
    try {
      fn();
      return null;
    } catch (err) {
      return err as { code?: unknown; message: string };
    }
  };

  it("hands back the very value for an action with no schema", () => {
    const result = { at: new Date(0) };
    expect(enforcePluginActionResult(ACTION, undefined, result)).toBe(result);
  });

  it("checks the JSON a caller receives, so a Date can't pass for an object", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const asObject = compilePluginActionResultSchema(ACTION, {
      type: "object",
      properties: { at: { type: "object" } },
    }).check;
    const asString = compilePluginActionResultSchema(ACTION, {
      type: "object",
      properties: { at: { type: "string" } },
    }).check;

    expect(
      rejection(() => enforcePluginActionResult(ACTION, asObject, { at: new Date(0) }))?.code
    ).toBe("RESULT_VALIDATION_ERROR");
    expect(enforcePluginActionResult(ACTION, asString, { at: new Date(0) })).toEqual({
      at: "1970-01-01T00:00:00.000Z",
    });
  });

  it("refuses a result that can't become JSON", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { check } = compilePluginActionResultSchema(ACTION, { type: "object" });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(rejection(() => enforcePluginActionResult(ACTION, check, cyclic))?.code).toBe(
      "RESULT_VALIDATION_ERROR"
    );
    expect(rejection(() => enforcePluginActionResult(ACTION, check, undefined))?.code).toBe(
      "RESULT_VALIDATION_ERROR"
    );
  });

  it("keeps the problem in the log and out of the error the caller gets", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { check } = compilePluginActionResultSchema(ACTION, {
      type: "object",
      additionalProperties: false,
    });

    const thrown = rejection(() =>
      enforcePluginActionResult(ACTION, check, { "/home/someone/notes.txt": 1 })
    );

    expect(thrown?.code).toBe("RESULT_VALIDATION_ERROR");
    expect(thrown?.message).not.toContain("notes.txt");
    expect(String(warn.mock.calls[0]?.[0])).toContain("notes.txt");
  });
});
