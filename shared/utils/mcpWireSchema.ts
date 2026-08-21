/**
 * The wire projection of a tool's JSON Schema — what the model is shown, as
 * distinct from what actually validates the call.
 *
 * One authoritative schema per action already exists: the zod `argsSchema`.
 * `ActionService.dispatch` validates every call against it, and the emitted JSON
 * Schema is never fed back into a validator — it exists only to be advertised.
 * That makes the two views a projection rather than a fork, which is the whole
 * point: hand-maintaining two schemas rots on the first edit.
 *
 * What this strips is the value-range family. Constrained-decoding backends do
 * not enforce these at the token-masking level, so they arrive as plain prompt
 * text: paid for on every turn, routinely violated anyway, and capable of
 * degrading output when the model's chosen path contradicts one.
 *
 * Server-side enforcement is unaffected, but it is worth being precise about
 * *which* enforcement, because it is not one mechanism: renderer-dispatched
 * actions are checked by `argsSchema.safeParse`, plugin-contributed actions by
 * the plugin host's own AJV pass against the original descriptor schema, and
 * main-process tools by their own hand-written argument checks. None of the
 * three reads this projection, so none of them weakens when it drops a keyword.
 *
 * This applies to INPUT schemas only. An advertised `outputSchema` is a
 * contract the MCP SDK compiles and enforces with AJV on the client, so it is
 * deliberately not projected — see `buildToolOutputSchema` in
 * `electron/services/mcp-server/tierAuth.ts`.
 *
 * A bound the caller genuinely needs in order to call correctly is therefore
 * prose, not a keyword: put it in the field's `.describe()`, where it survives
 * this projection and reads as the instruction it is.
 *
 * Deliberately kept OUT of this projection: `type`, `properties`, `required`,
 * `enum`, `default`, `description`, `const`, the combinator keywords, and
 * `additionalProperties`. The last one plus a complete `required` array is what
 * lets a strict backend build a deterministic mask, and it measurably reduces
 * hallucinated keys — stripping it would cost accuracy to save bytes.
 */

/**
 * Value-range keywords, stripped from the wire view.
 *
 * `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf`, `minContains` and
 * `maxContains` are the same class of constraint as the rest and are stripped
 * for the same reason, even though the authoring standard's list names only the
 * nine common ones. Leaving them in would hold the door open for exactly the
 * bytes this removes, and a reader would have no way to tell the omission from
 * a decision.
 */
export const WIRE_STRIPPED_KEYWORDS: ReadonlySet<string> = new Set([
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "minProperties",
  "maxProperties",
  "minContains",
  "maxContains",
  "pattern",
]);

/** JSON Schema keywords whose value is itself a schema. */
const SCHEMA_VALUED_KEYS: ReadonlySet<string> = new Set([
  "items",
  "additionalItems",
  "additionalProperties",
  "unevaluatedItems",
  "unevaluatedProperties",
  "contains",
  "contentSchema",
  "propertyNames",
  "not",
  "if",
  "then",
  "else",
]);

/** Keywords whose value is a map of name → schema. */
const SCHEMA_MAP_KEYS: ReadonlySet<string> = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
]);

/** Keywords whose value is an array of schemas. */
const SCHEMA_LIST_KEYS: ReadonlySet<string> = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);

/**
 * Strip the value-range keywords from a JSON Schema, walking by keyword rather
 * than by name.
 *
 * The distinction is load-bearing. A schema is free to declare a *property*
 * called `pattern` or `maximum` — `{properties: {pattern: {type: "string"}}}` is
 * a legal tool argument, and a blind key-delete would silently drop it from the
 * advertised surface, leaving a required argument the model is never told about.
 * So recursion only descends into positions that actually hold schemas, and the
 * strip only fires on a keyword sitting in a schema position.
 *
 * Unrecognised keywords are copied verbatim rather than traversed. That errs
 * toward keeping bytes: a range keyword nested under a keyword this function has
 * never heard of survives into the wire view. The cost is a few bytes; the
 * inverse error would be dropping a constraint that some other consumer needs,
 * which is the direction worth avoiding.
 */
export function toWireSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(toWireSchema);
  if (node === null || typeof node !== "object") return node;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (WIRE_STRIPPED_KEYWORDS.has(key)) continue;

    if (SCHEMA_VALUED_KEYS.has(key) || SCHEMA_LIST_KEYS.has(key)) {
      out[key] = toWireSchema(value);
    } else if (SCHEMA_MAP_KEYS.has(key) && value !== null && typeof value === "object") {
      out[key] = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([name, schema]) => [
          name,
          toWireSchema(schema),
        ])
      );
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Every value-range keyword still present in a schema, as `path → keyword`. */
export function findWireStrippedKeywords(node: unknown, path = ""): string[] {
  const found: string[] = [];
  const walk = (value: unknown, at: string): void => {
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, `${at}[${i}]`));
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (WIRE_STRIPPED_KEYWORDS.has(key)) {
        found.push(`${at || "<root>"}.${key}`);
        continue;
      }
      if (SCHEMA_VALUED_KEYS.has(key) || SCHEMA_LIST_KEYS.has(key)) {
        walk(child, at ? `${at}.${key}` : key);
      } else if (SCHEMA_MAP_KEYS.has(key) && child !== null && typeof child === "object") {
        for (const [name, schema] of Object.entries(child as Record<string, unknown>)) {
          walk(schema, at ? `${at}.${key}.${name}` : `${key}.${name}`);
        }
      }
    }
  };
  walk(node, path);
  return found;
}
