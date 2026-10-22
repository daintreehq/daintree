import { describe, expect, it } from "vitest";
import { parsePluginPaletteArgs, validateStringField } from "../pluginPaletteArgs";
import type { StringPromptField } from "../pluginPaletteArgs";

const object = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object",
  properties,
  required,
});

describe("parsePluginPaletteArgs", () => {
  it("describes required fields in declaration order and skips optional ones", () => {
    const spec = parsePluginPaletteArgs(
      object(
        {
          note: { type: "string" },
          env: { type: "string", enum: ["dev", "prod"], title: "Environment" },
          force: { type: "boolean" },
        },
        ["force", "env"]
      )
    );
    expect(spec?.fields.map((f) => [f.name, f.kind, f.title])).toEqual([
      ["env", "enum", "Environment"],
      ["force", "boolean", "force"],
    ]);
  });

  it("keeps enum values typed, apart from their labels", () => {
    const spec = parsePluginPaletteArgs(
      object({ level: { type: "integer", enum: [1, 2, 3] } }, ["level"])
    );
    const field = spec!.fields[0]!;
    expect(field.kind === "enum" && field.options.map((o) => o.value)).toEqual([1, 2, 3]);
  });

  it.each([
    ["no required fields", object({ a: { type: "string" } }, [])],
    ["an unknown root keyword", { ...object({ a: { type: "string" } }, ["a"]), oneOf: [] }],
    ["a $ref", object({ a: { $ref: "#/defs/a" } }, ["a"])],
    ["a nested object", object({ a: { type: "object", properties: {} } }, ["a"])],
    ["an array", object({ a: { type: "array", items: { type: "string" } } }, ["a"])],
    ["a nullable union", object({ a: { type: ["string", "null"] } }, ["a"])],
    ["a const", object({ a: { type: "string", const: "x" } }, ["a"])],
    ["a default", object({ a: { type: "string", default: "x" } }, ["a"])],
    ["free-form numbers", object({ a: { type: "number" } }, ["a"])],
    ["an invalid pattern", object({ a: { type: "string", pattern: "(" } }, ["a"])],
    [
      "inverted length bounds",
      object({ a: { type: "string", minLength: 3, maxLength: 1 } }, ["a"]),
    ],
    ["an enum with mixed types", object({ a: { type: "string", enum: ["x", 1] } }, ["a"])],
    ["an enum with duplicates", object({ a: { type: "string", enum: ["x", "x"] } }, ["a"])],
    [
      "an enum plus string constraints",
      object({ a: { type: "string", enum: ["x"], minLength: 1 } }, ["a"]),
    ],
    ["a required name with no property", object({ a: { type: "string" } }, ["b"])],
    ["an inherited required name", object({ a: { type: "string" } }, ["toString"])],
    ["a catastrophic pattern", object({ a: { type: "string", pattern: "^(a+)+$" } }, ["a"])],
    ["a backreference pattern", object({ a: { type: "string", pattern: "(a)\\1" } }, ["a"])],
    ["a prototype-polluting name", object({ constructor: { type: "string" } }, ["constructor"])],
    [
      "a schema-valued additionalProperties",
      { ...object({ a: { type: "string" } }, ["a"]), additionalProperties: {} },
    ],
    [
      "more than five properties",
      object(Object.fromEntries("abcdef".split("").map((k) => [k, { type: "string" }])), ["a"]),
    ],
  ])("rejects %s", (_label, schema) => {
    expect(parsePluginPaletteArgs(schema)).toBeNull();
  });

  it("rejects non-objects", () => {
    expect(parsePluginPaletteArgs(undefined)).toBeNull();
    expect(parsePluginPaletteArgs("x")).toBeNull();
    expect(parsePluginPaletteArgs([])).toBeNull();
  });
});

describe("validateStringField", () => {
  const field = (extra: Partial<StringPromptField>): StringPromptField => ({
    kind: "string",
    name: "a",
    title: "A",
    ...extra,
  });

  it("counts code points, not UTF-16 units", () => {
    expect(validateStringField(field({ maxLength: 2 }), "😀😀")).toBeNull();
    expect(validateStringField(field({ maxLength: 2 }), "😀😀😀")).not.toBeNull();
    expect(validateStringField(field({ minLength: 2 }), "😀")).not.toBeNull();
  });

  it("allows an empty value unless a bound forbids it", () => {
    expect(validateStringField(field({}), "")).toBeNull();
    expect(validateStringField(field({ minLength: 1 }), "")).not.toBeNull();
  });

  it("matches the pattern unanchored", () => {
    const f = field({ pattern: /^v\d+$/u });
    expect(validateStringField(f, "v12")).toBeNull();
    expect(validateStringField(f, "x v12")).not.toBeNull();
    expect(validateStringField(field({ pattern: /\d/u }), "ab1c")).toBeNull();
  });
});
