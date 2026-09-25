import { describe, expect, it } from "vitest";
import type { PluginMcpJsonSchema } from "../../../../shared/types/plugin.js";
import { compileAgentMcpSchema } from "../schemaValidation.js";

function schema(fields: Record<string, unknown>): PluginMcpJsonSchema {
  return { type: "object", ...fields };
}

describe("compileAgentMcpSchema", () => {
  it("returns null for a conforming value and a description for one that is not", () => {
    const check = compileAgentMcpSchema(
      schema({ properties: { id: { type: "string" } }, required: ["id"] })
    );
    expect(check({ id: "r-1" })).toBeNull();
    expect(check({})).toBe("/ must have required property 'id'");
    expect(check({ id: 1 })).toBe("/id must be string");
  });

  it("leaves the value exactly as sent: nothing coerced, defaulted or stripped", () => {
    const check = compileAgentMcpSchema(
      schema({
        properties: { count: { type: "integer", default: 1 }, flag: { type: "boolean" } },
        additionalProperties: false,
      })
    );
    const coercible = { flag: "true" };
    expect(check(coercible)).toBe("/flag must be boolean");
    expect(coercible).toEqual({ flag: "true" });

    const extra = { flag: true, other: 1 };
    expect(check(extra)).toBe('/ must NOT have additional properties ("other")');
    expect(extra).toEqual({ flag: true, other: 1 });

    const defaultless = {};
    expect(check(defaultless)).toBeNull();
    expect(defaultless).toEqual({});
  });

  it("names the property behind unevaluated-property and property-name failures", () => {
    const unevaluated = compileAgentMcpSchema(
      schema({ properties: { a: {} }, unevaluatedProperties: false })
    );
    expect(unevaluated({ b: 1 })).toBe('/ must NOT have unevaluated properties ("b")');

    const names = compileAgentMcpSchema(schema({ propertyNames: { maxLength: 2 } }));
    expect(names({ abc: 1 })).toMatch(/property name must be valid \("abc"\)/);
  });

  it("joins every error Ajv reports and bounds the description", () => {
    const check = compileAgentMcpSchema(
      schema({ properties: { v: { anyOf: [{ type: "string" }, { type: "number" }] } } })
    );
    expect(check({ v: true })).toBe(
      "/v must be string; /v must be number; /v must match a schema in anyOf"
    );

    const long = compileAgentMcpSchema(schema({ required: ["x".repeat(2_000)] }));
    const problem = long({});
    expect(problem?.length).toBe(1_001);
    expect(problem?.endsWith("…")).toBe(true);
  });

  it("enforces formats", () => {
    const check = compileAgentMcpSchema(
      schema({ properties: { on: { type: "string", format: "date" } } })
    );
    expect(check({ on: "2026-09-22" })).toBeNull();
    expect(check({ on: "2026-13-40" })).toBe('/on must match format "date"');
  });

  it("uses JSON Schema 2020-12 by default and draft-07 when the schema declares it", () => {
    const tuple2020 = compileAgentMcpSchema(
      schema({ properties: { pair: { prefixItems: [{ type: "string" }, { type: "number" }] } } })
    );
    expect(tuple2020({ pair: ["a", 1] })).toBeNull();
    expect(tuple2020({ pair: [1, "a"] })).toMatch(/\/pair\/0 must be string/);

    for (const $schema of [
      "http://json-schema.org/draft-07/schema#",
      "http://json-schema.org/draft-07/schema",
    ]) {
      const tuple07 = compileAgentMcpSchema(
        schema({
          $schema,
          properties: { pair: { items: [{ type: "string" }, { type: "number" }] } },
        })
      );
      expect(tuple07({ pair: [1, "a"] })).toMatch(/\/pair\/0 must be string/);
    }

    expect(() =>
      compileAgentMcpSchema(schema({ $schema: "https://json-schema.org/draft/2020-12/schema" }))
    ).not.toThrow();
  });

  it.each([
    ["draft-04", "http://json-schema.org/draft-04/schema#"],
    ["2019-09", "https://json-schema.org/draft/2019-09/schema"],
    ["a non-string", 7],
  ])("refuses a %s $schema", (_label, $schema) => {
    expect(() => compileAgentMcpSchema(schema({ $schema }))).toThrow(
      /only JSON Schema 2020-12 \(the default\) and draft-07 are supported/
    );
  });

  it("resolves references within the schema, including an embedded resource", () => {
    const check = compileAgentMcpSchema(
      schema({
        $defs: {
          id: { type: "string" },
          node: {
            type: "object",
            properties: { id: { $ref: "#/$defs/id" }, child: { $ref: "#/$defs/node" } },
          },
          embedded: { $id: "https://acme.example/money", type: "integer" },
        },
        properties: {
          root: { $ref: "#/$defs/node" },
          cents: { $ref: "https://acme.example/money" },
        },
      })
    );
    expect(check({ root: { id: "a", child: { id: "b" } }, cents: 5 })).toBeNull();
    expect(check({ root: { child: { id: 7 } } })).toBe("/root/child/id must be string");
    expect(check({ cents: 1.5 })).toBe("/cents must be integer");
  });

  it.each([
    ["a remote document", "https://example.com/schemas/record.json"],
    ["the dialect's own meta-schema", "https://json-schema.org/draft/2020-12/schema"],
    ["a relative document", "record.json"],
  ])("refuses a reference to %s", (_label, ref) => {
    expect(() => compileAgentMcpSchema(schema({ properties: { record: { $ref: ref } } }))).toThrow(
      /which does not resolve within the schema; references to anything outside it/
    );
  });

  it("keeps each schema's identifiers to itself", () => {
    const first = schema({ $id: "https://acme.example/shared", properties: { a: {} } });
    const second = schema({ $id: "https://acme.example/shared", properties: { b: {} } });
    expect(() => compileAgentMcpSchema(first)).not.toThrow();
    expect(() => compileAgentMcpSchema(second)).not.toThrow();
    // Another tool's identifier is not something a schema can reach.
    expect(() =>
      compileAgentMcpSchema(schema({ properties: { a: { $ref: "https://acme.example/shared" } } }))
    ).toThrow(/does not resolve within the schema/);
  });

  it("follows a reference to the schema's own root", () => {
    const check = compileAgentMcpSchema(
      schema({ properties: { name: { type: "string" }, child: { $ref: "#" } } })
    );
    expect(check({ name: "a", child: { name: "b", child: {} } })).toBeNull();
    expect(check({ child: { child: { name: 1 } } })).toBe("/child/child/name must be string");
  });

  it("names a reference to a part of the schema that does not exist", () => {
    expect(() =>
      compileAgentMcpSchema(schema({ properties: { a: { $ref: "#/$defs/missing" } } }))
    ).toThrow('references "#/$defs/missing", which does not resolve within the schema');
  });

  it("refuses $dynamicRef, which Ajv resolves to the wrong schema", () => {
    expect(() =>
      compileAgentMcpSchema(
        schema({
          $defs: { id: { $dynamicAnchor: "id", type: "integer" } },
          properties: { id: { $dynamicRef: "#id" } },
        })
      )
    ).toThrow("uses $dynamicRef at /properties/id, which is not supported");
    expect(() =>
      compileAgentMcpSchema(
        schema({ $defs: { id: { type: "integer" } }, properties: { id: { $recursiveRef: "#" } } })
      )
    ).toThrow("uses $recursiveRef at /properties/id, which is not supported");
    // A property named like a keyword is still checked as a schema.
    expect(() =>
      compileAgentMcpSchema(schema({ properties: { default: { $dynamicRef: "#id" } } }))
    ).toThrow("uses $dynamicRef at /properties/default");
  });

  it("reads property names and literal data as data, not keywords", () => {
    expect(() =>
      compileAgentMcpSchema(
        schema({
          properties: {
            $dynamicRef: { type: "string" },
            $schema: { type: "string", default: "http://json-schema.org/draft-04/schema#" },
            doc: {
              const: { $dynamicRef: "#literal" },
              default: { $schema: "https://example.com/payload" },
              examples: [{ $schema: "https://example.com/payload" }],
            },
          },
          required: ["$schema"],
        })
      )
    ).not.toThrow();
  });

  it("refuses an embedded resource in another dialect, which would be checked as the root's", () => {
    expect(() =>
      compileAgentMcpSchema(
        schema({
          $defs: {
            pair: {
              $id: "https://acme.example/pair",
              $schema: "http://json-schema.org/draft-07/schema#",
              items: [{ type: "string" }],
            },
          },
        })
      )
    ).toThrow(
      'declares $schema "http://json-schema.org/draft-07/schema#" at /$defs/pair; a schema must use one dialect throughout'
    );
    expect(() =>
      compileAgentMcpSchema(
        schema({
          $defs: {
            pair: {
              $id: "https://acme.example/pair",
              $schema: "https://json-schema.org/draft/2020-12/schema",
              prefixItems: [{ type: "string" }],
            },
          },
        })
      )
    ).not.toThrow();
  });

  it.each([
    [
      "an invalid keyword value",
      schema({ properties: { a: { type: "strng" } } }),
      /not a valid JSON Schema: \/properties\/a\/type/,
    ],
    [
      "an unparseable pattern",
      schema({ properties: { a: { type: "string", pattern: "(" } } }),
      /cannot be compiled: .*regular expression/i,
    ],
    [
      "an unknown format",
      schema({ properties: { a: { type: "string", format: "uuid4" } } }),
      /cannot be compiled: unknown format "uuid4"/,
    ],
    ["an async schema", schema({ $async: true }), /async \(\$async\) schema/],
  ])("refuses %s", (_label, candidate, why) => {
    expect(() => compileAgentMcpSchema(candidate)).toThrow(why);
  });

  it("accepts annotations and keywords it does not know", () => {
    expect(() =>
      compileAgentMcpSchema(
        schema({
          title: "Record",
          "x-acme-owner": "ledger",
          properties: {
            memo: { type: "string", examples: ["weekly shop"], default: "", "x-widget": "area" },
          },
        })
      )
    ).not.toThrow();
  });

  it("compiles a frozen schema", () => {
    const frozen = Object.freeze(
      schema({ properties: Object.freeze({ a: Object.freeze({ type: "string" }) }) })
    );
    expect(compileAgentMcpSchema(frozen)({ a: 1 })).toBe("/a must be string");
  });

  it("answers rather than throws when the value is too deep to check", () => {
    const check = compileAgentMcpSchema(
      schema({
        $defs: { node: { type: "object", properties: { c: { $ref: "#/$defs/node" } } } },
        properties: { c: { $ref: "#/$defs/node" } },
      })
    );
    let value: Record<string, unknown> = {};
    for (let depth = 0; depth < 200_000; depth++) value = { c: value };
    expect(check(value)).toMatch(/^could not be checked: /);
  });
});
