import { z } from "zod";
import { ElementPickerFrameworkSchema } from "./source.js";

export const EVIDENCE_LIMITS = {
  /** Several frameworks can own parts of one element's context (an Astro island around a React tree). */
  entries: 8,
  /** Matches the Svelte ancestry and structure depth the picker already walks to. */
  depth: 64,
  genericFields: 16,
  occurrences: 100_000,
} as const;

/**
 * What Svelte's dev runtime says about a node, kept in Svelte's own terms. The
 * neutral component chain cannot hold it: Svelte's parent chain interleaves
 * `if`, `each`, `await`, `key`, `snippet` and `render` blocks with component
 * call sites, and those blocks are how a selection in one branch of a template
 * is told apart from the same markup in another.
 *
 * Locations here are verbatim `__svelte_meta` readings, 1-based lines and
 * 0-based columns. `type` is a string, not an enum, so a block kind a newer
 * compiler adds still arrives rather than failing the whole observation.
 */
export const SvelteEvidenceSchema = z.strictObject({
  kind: z.literal("svelte"),
  /** Verbatim `__svelte_meta.parent` chain, innermost first. */
  ancestry: z
    .array(
      z.strictObject({
        type: z.string().min(1).max(32),
        file: z.string().min(1).max(1024),
        line: z.number().int().positive(),
        column: z.number().int().nonnegative(),
        /** The tag a `component` entry was written as at its call site. */
        componentTag: z.string().min(1).max(128).optional(),
      })
    )
    .max(EVIDENCE_LIMITS.depth),
  /** Live nodes sharing this node's template location. */
  sameLocCount: z.number().int().positive().max(EVIDENCE_LIMITS.occurrences),
  /** The page stopped counting at its scan bound, so `sameLocCount` is a floor. */
  sameLocCountPartial: z.literal(true).optional(),
  /** Which of those nodes this is, in document order. */
  locIndex: z.number().int().nonnegative().max(EVIDENCE_LIMITS.occurrences).optional(),
  /** The node's place in its template, outermost first: for a hydrated page whose stamped location is a neighbour's. */
  structure: z
    .strictObject({
      file: z.string().min(1).max(1024),
      path: z
        .array(
          z.strictObject({
            tag: z.string().min(1).max(64),
            index: z.number().int().nonnegative().max(EVIDENCE_LIMITS.occurrences),
          })
        )
        .min(1)
        .max(EVIDENCE_LIMITS.depth),
    })
    .optional(),
  /** Inside `{@html}`, a canvas or a shadow root: rendered, but not by a template Svelte can name. */
  unmapped: z.boolean(),
});
export type SvelteEvidence = z.infer<typeof SvelteEvidenceSchema>;

/**
 * Anything a framework reports that has no typed home yet: flat, named and
 * primitive, so neutral code can show it without trusting a nested structure
 * the page shaped. A framework that needs more gets its own variant, as Svelte
 * has.
 */
export const GenericEvidenceSchema = z.strictObject({
  kind: z.literal("generic"),
  framework: ElementPickerFrameworkSchema,
  fields: z
    .array(
      z.strictObject({
        name: z.string().min(1).max(64),
        value: z.union([z.string().max(256), z.number(), z.boolean(), z.null()]),
      })
    )
    .max(EVIDENCE_LIMITS.genericFields),
});
export type GenericEvidence = z.infer<typeof GenericEvidenceSchema>;

export const FrameworkEvidenceSchema = z.discriminatedUnion("kind", [
  SvelteEvidenceSchema,
  GenericEvidenceSchema,
]);
export type FrameworkEvidence = z.infer<typeof FrameworkEvidenceSchema>;
