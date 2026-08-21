import { describe, it, expect } from "vitest";
import {
  toWireSchema,
  findWireStrippedKeywords,
  WIRE_STRIPPED_KEYWORDS,
} from "../mcpWireSchema.js";

describe("toWireSchema", () => {
  it("drops value-range keywords from a schema position", () => {
    const wire = toWireSchema({
      type: "object",
      properties: {
        count: { type: "integer", minimum: 1, maximum: 100, description: "How many" },
        name: { type: "string", minLength: 1, maxLength: 64, pattern: "^[a-z]+$" },
      },
      required: ["count"],
    });

    expect(wire).toEqual({
      type: "object",
      properties: {
        count: { type: "integer", description: "How many" },
        name: { type: "string" },
      },
      required: ["count"],
    });
  });

  it("keeps the keywords a constrained backend actually masks on", () => {
    // `enum`, `default`, `const` and `additionalProperties: false` are what let a
    // strict backend build a deterministic mask. Stripping any of them would cost
    // accuracy to save bytes, which is the opposite of the trade being made.
    const wire = toWireSchema({
      type: "object",
      additionalProperties: false,
      properties: {
        mode: { type: "string", enum: ["fast", "slow"], default: "fast" },
        kind: { const: "worktree" },
      },
      required: ["mode"],
    });

    expect(wire).toEqual({
      type: "object",
      additionalProperties: false,
      properties: {
        mode: { type: "string", enum: ["fast", "slow"], default: "fast" },
        kind: { const: "worktree" },
      },
      required: ["mode"],
    });
  });

  it("never drops a property that happens to be NAMED like a keyword", () => {
    // The trap this walk exists for: `pattern` and `maximum` are legal argument
    // names. A blind key-delete would silently un-advertise a required argument,
    // leaving the model unable to call the tool correctly and no error anywhere.
    const wire = toWireSchema({
      type: "object",
      properties: {
        pattern: { type: "string", description: "The glob to match", maxLength: 200 },
        maximum: { type: "number", description: "Upper bound the caller wants", minimum: 0 },
      },
      required: ["pattern", "maximum"],
    });

    expect(wire).toEqual({
      type: "object",
      properties: {
        pattern: { type: "string", description: "The glob to match" },
        maximum: { type: "number", description: "Upper bound the caller wants" },
      },
      required: ["pattern", "maximum"],
    });
  });

  it("descends through combinators, items and $defs", () => {
    const wire = toWireSchema({
      type: "object",
      $defs: { tag: { type: "string", minLength: 2 } },
      properties: {
        tags: { type: "array", items: { type: "string", maxLength: 8 }, minItems: 1 },
        either: {
          anyOf: [
            { type: "string", pattern: "^a" },
            { type: "number", multipleOf: 5 },
          ],
        },
      },
    });

    expect(wire).toEqual({
      type: "object",
      $defs: { tag: { type: "string" } },
      properties: {
        tags: { type: "array", items: { type: "string" } },
        either: { anyOf: [{ type: "string" }, { type: "number" }] },
      },
    });
  });

  it("is idempotent", () => {
    // The authoring standard's central requirement: a conforming artifact passed
    // through the projection again comes back byte-identical. Without this the
    // projection cannot be safely re-run, in CI or anywhere else.
    const source = {
      type: "object",
      properties: {
        a: { type: "string", minLength: 3, description: "A" },
        b: { type: "array", items: { type: "integer", minimum: 0 }, maxItems: 4 },
      },
    };
    const once = toWireSchema(source);
    const twice = toWireSchema(once);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });

  it("leaves non-schema values alone", () => {
    expect(toWireSchema(null)).toBeNull();
    expect(toWireSchema("text")).toBe("text");
    expect(toWireSchema(7)).toBe(7);
  });
});

describe("findWireStrippedKeywords", () => {
  it("reports what a projection would remove, and finds nothing in its output", () => {
    const source = {
      type: "object",
      properties: {
        count: { type: "integer", minimum: 1 },
        tags: { type: "array", items: { type: "string", maxLength: 4 } },
      },
    };

    expect(findWireStrippedKeywords(source).sort()).toEqual([
      "properties.count.minimum",
      "properties.tags.items.maxLength",
    ]);
    expect(findWireStrippedKeywords(toWireSchema(source))).toEqual([]);
  });

  it("does not report a property merely named after a keyword", () => {
    expect(
      findWireStrippedKeywords({ type: "object", properties: { pattern: { type: "string" } } })
    ).toEqual([]);
  });
});

describe("WIRE_STRIPPED_KEYWORDS", () => {
  it("covers the whole value-range family rather than a sample of it", () => {
    // Half-covering the family is the failure mode: `minimum` stripped while
    // `exclusiveMinimum` survives reads as a decision nobody made, and holds the
    // door open for exactly the bytes the projection removes.
    for (const paired of [
      ["minimum", "exclusiveMinimum"],
      ["maximum", "exclusiveMaximum"],
      ["minItems", "maxItems"],
      ["minLength", "maxLength"],
      ["minProperties", "maxProperties"],
    ]) {
      for (const keyword of paired) {
        expect(WIRE_STRIPPED_KEYWORDS.has(keyword), `${keyword} must be stripped`).toBe(true);
      }
    }
  });

  it("never strips a keyword the model needs in order to call correctly", () => {
    for (const keyword of [
      "type",
      "properties",
      "required",
      "enum",
      "default",
      "description",
      "const",
      "additionalProperties",
      "items",
      "anyOf",
      "oneOf",
      "allOf",
    ]) {
      expect(WIRE_STRIPPED_KEYWORDS.has(keyword), `${keyword} must survive`).toBe(false);
    }
  });
});
