import { z } from "zod";
import {
  ElementPickerProviderIdSchema,
  ObservedNameSchema,
  PickerIdSchema,
  SourceCandidateSchema,
} from "./source.js";

export const COMPONENT_LIMITS = {
  /** Records in one chain; matches the Svelte ancestry cap the picker already bounds walks to. */
  records: 64,
  /** Rendered roots one record lists; a fragment or portal-heavy component past this is `rootsComplete: false`. */
  roots: 32,
  candidates: 4,
} as const;

/**
 * Server components render on the server and leave no instance in the page, so
 * they have no DOM roots of their own. `unknown` is a framework that does not
 * say, not a guess at either.
 */
export const ComponentEnvironmentSchema = z.enum(["client", "server", "unknown"]);
export type ComponentEnvironment = z.infer<typeof ComponentEnvironmentSchema>;

/**
 * One component instance as the page observed it. Identity is `componentId`,
 * minted per document: never a name, a file or a call site, which wrappers and
 * repeated invocations share.
 *
 * Render ancestry and owner ancestry are separate edges because they are
 * different facts. The render parent is whoever has this instance in its
 * output tree; the owner is whoever created the element that made it. They
 * diverge whenever JSX or a snippet is passed down as children. Each edge is
 * omitted when it was not observed, `null` when it was observed to be absent,
 * and an id that must name another record in the same chain.
 */
export const ComponentRecordSchema = z.strictObject({
  componentId: PickerIdSchema,
  framework: ElementPickerProviderIdSchema,
  /** Null for an anonymous component, not one whose name was not read. */
  name: ObservedNameSchema.nullable(),
  environment: ComponentEnvironmentSchema,
  renderParentId: PickerIdSchema.nullable().optional(),
  ownerId: PickerIdSchema.nullable().optional(),
  /** Element ids in the same document; they may name elements outside this observation. */
  rootElementIds: z.array(PickerIdSchema).max(COMPONENT_LIMITS.roots),
  rootsComplete: z.boolean(),
  sourceCandidates: z.array(SourceCandidateSchema).max(COMPONENT_LIMITS.candidates),
});
export type ComponentRecord = z.infer<typeof ComponentRecordSchema>;

type Edge = "renderParentId" | "ownerId";

function hasCycle(records: readonly ComponentRecord[], edge: Edge): boolean {
  const next = new Map(records.map((record) => [record.componentId, record[edge] ?? null]));
  for (const start of next.keys()) {
    const seen = new Set<string>();
    for (let id: string | null = start; id !== null; id = next.get(id) ?? null) {
      if (seen.has(id)) return true;
      seen.add(id);
    }
  }
  return false;
}

/**
 * The components above an element, as a flat graph rather than a nested tree:
 * the depth stays bounded by a count, and render and owner edges can each be
 * followed without one being forced into the shape of the other. A walk that
 * hit its bound reports `truncated` and omits the edges it did not follow
 * rather than pointing them at records it never sent.
 */
export const ComponentChainSchema = z
  .strictObject({
    /** The innermost component the element belongs to; null when none was observed. */
    nearestId: PickerIdSchema.nullable(),
    components: z.array(ComponentRecordSchema).max(COMPONENT_LIMITS.records),
    truncated: z.boolean(),
  })
  .superRefine((chain, ctx) => {
    const ids = new Set<string>();
    chain.components.forEach((record, index) => {
      if (ids.has(record.componentId)) {
        ctx.addIssue({
          code: "custom",
          path: ["components", index, "componentId"],
          message: "duplicate component id",
        });
      }
      ids.add(record.componentId);
    });
    if (chain.nearestId !== null && !ids.has(chain.nearestId)) {
      ctx.addIssue({ code: "custom", path: ["nearestId"], message: "names no record" });
    }
    chain.components.forEach((record, index) => {
      for (const edge of ["renderParentId", "ownerId"] as const) {
        const target = record[edge];
        if (typeof target === "string" && !ids.has(target)) {
          ctx.addIssue({
            code: "custom",
            path: ["components", index, edge],
            message: "names no record",
          });
        }
      }
    });
    // Per edge: an owner chain that loops back through render parents is not a cycle.
    for (const edge of ["renderParentId", "ownerId"] as const) {
      if (hasCycle(chain.components, edge)) {
        ctx.addIssue({ code: "custom", path: ["components"], message: `${edge} cycle` });
      }
    }
  });
export type ComponentChain = z.infer<typeof ComponentChainSchema>;
