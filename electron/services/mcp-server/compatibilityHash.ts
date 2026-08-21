/**
 * Canonicalisation shared by the two compatibility digests main publishes: the
 * whole-surface hash on `mcp.surface` (#11549) and the per-target hash on an
 * `actions.getSchema` policy record (#11910).
 *
 * Extracted so the two cannot drift. A client that compares a per-target hash
 * against a surface it captured earlier is comparing digests of the same
 * normalised shape — if these normalisers diverged, one of the two would start
 * reporting drift the other never saw, and neither would be wrong from its own
 * side.
 */

/** JSON Schema keywords whose value is itself a schema. */
const SCHEMA_VALUED_KEYS = new Set([
  "items",
  "additionalItems",
  "additionalProperties",
  "unevaluatedItems",
  "unevaluatedProperties",
  "contains",
  "propertyNames",
  "not",
  "if",
  "then",
  "else",
]);

/** Keywords whose value is a map of name → schema. */
const SCHEMA_MAP_KEYS = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
]);

/** Keywords whose value is an array of schemas. */
const SCHEMA_LIST_KEYS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);

/**
 * Keywords that document a schema without constraining it. Stripped before
 * hashing so rewording a `.describe()` cannot read as a compatibility break —
 * the same promise the tool's own description gets, applied one level down.
 */
const SCHEMA_PROSE_KEYS = new Set(["description", "title", "$comment", "examples"]);

/**
 * A schema reduced to what a caller's compatibility actually depends on.
 *
 * Walks by keyword rather than blindly deleting every key named `description`,
 * because a schema is free to declare a *property* called `description` — that
 * one is part of the contract, and only the annotation slot beside it is prose.
 *
 * Unrecognised keywords are copied verbatim rather than traversed, which errs
 * deliberately toward over-sensitivity: a constraint this function has never
 * heard of stays in the digest, and the cost is that prose buried under such a
 * keyword can still move the hash. That direction is the safe one — a spurious
 * change costs a client one re-read, while a dropped constraint would hide a
 * real incompatibility forever. The classified sets cover everything Zod v4
 * emits; a plugin shipping a hand-written draft-07 schema is the case that can
 * land in the verbatim branch.
 *
 * `required` is sorted: it is a set in JSON Schema semantics, so its emitted
 * order is an artifact of the generator, not a contract. Every other array
 * keeps its order — `enum`, `prefixItems`, and `allOf` all mean something
 * different when reordered.
 */
export function toCompatibilityShape(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(toCompatibilityShape);
  if (node === null || typeof node !== "object") return node;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (SCHEMA_PROSE_KEYS.has(key)) continue;
    if (key === "required" && Array.isArray(value)) {
      out[key] = [...(value as unknown[])].sort();
    } else if (SCHEMA_VALUED_KEYS.has(key) || SCHEMA_LIST_KEYS.has(key)) {
      out[key] = toCompatibilityShape(value);
    } else if (SCHEMA_MAP_KEYS.has(key) && value !== null && typeof value === "object") {
      out[key] = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([name, schema]) => [
          name,
          toCompatibilityShape(schema),
        ])
      );
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Recursively key-sorted JSON, so the hash preimage depends on the surface's
 * content rather than on the order a JSON Schema generator happened to emit
 * object keys in. Arrays keep their order — {@link toCompatibilityShape} has
 * already normalised the one array whose order is meaningless.
 *
 * Deliberately a local copy rather than a reuse of `sessionDedup`'s
 * `canonicalArgsHash`: this canonical form is part of a published client
 * contract, and it must not shift because the unrelated per-call dedup key
 * changed shape.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      const record = v as Record<string, unknown>;
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(record).sort()) {
        sorted[key] = record[key];
      }
      return sorted;
    }
    return v;
  });
}
