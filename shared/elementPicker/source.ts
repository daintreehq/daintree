import { z } from "zod";
import { SourceLocationSchema } from "./coordinates.js";

/**
 * The frameworks a page may name. A fixed set: the page picks from it and the
 * host decides what that unlocks, so a page can never name an extractor or a
 * resolver into existence. Meta-frameworks (SvelteKit, Next.js, Nuxt) are
 * detector evidence on top of the framework they render with.
 */
export const ElementPickerFrameworkSchema = z.enum([
  "svelte",
  "react",
  "vue",
  "angular",
  "astro",
  "preact",
  "solid",
]);
export type ElementPickerFramework = z.infer<typeof ElementPickerFrameworkSchema>;

/** Document-local and opaque. Minted by the guest; meaningless outside its session and epoch. */
export const PickerIdSchema = z.string().min(1).max(128);

/** A path or URL as the page reported it. Evidence to resolve, never a file the host opens as-is. */
export const ReportedFileSchema = z.string().min(1).max(2048);

/**
 * Where a claim was read from. `field` and `attribute` name the exact runtime
 * property or DOM attribute (`__svelte_meta.loc`, `type.__file`,
 * `data-v-inspector`) so a surface can say where a name or location came from
 * rather than just asserting it.
 */
export const ExtractionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("runtime-field"), field: z.string().min(1).max(128) }),
  /**
   * A frame from a stack the runtime captured (React's `_debugStack`). The
   * candidate's file is then the generated module's URL and its location is in
   * generated coordinates: a claim about what the dev server served, which the
   * host has to map before it names an authored line.
   */
  z.strictObject({
    kind: z.literal("generated-stack-frame"),
    field: z.string().min(1).max(128),
    frameIndex: z.number().int().nonnegative().max(256),
  }),
  z.strictObject({ kind: z.literal("attribute"), attribute: z.string().min(1).max(128) }),
]);
export type Extraction = z.infer<typeof ExtractionSchema>;

/** A component name, with the field it was read from: a name is a claim like any location. */
export const ObservedNameSchema = z.strictObject({
  value: z.string().min(1).max(256),
  extraction: ExtractionSchema,
});
export type ObservedName = z.infer<typeof ObservedNameSchema>;

/**
 * What a candidate claims to be. These are different facts about different
 * source, and substituting one for another is how a tool names the wrong line:
 * an element's creation site is not its component's definition, and the call
 * site that produced this copy of a component is neither.
 */
export const SourceClaimKindSchema = z.enum([
  "element-creation",
  "component-invocation",
  "component-definition",
  "template-location",
  "file-hint",
]);
export type SourceClaimKind = z.infer<typeof SourceClaimKindSchema>;

const candidateFields = {
  candidateId: PickerIdSchema,
  framework: ElementPickerFrameworkSchema,
  extraction: ExtractionSchema,
  file: ReportedFileSchema,
};

const positionedCandidate = <K extends Exclude<SourceClaimKind, "file-hint">>(kind: K) =>
  z.strictObject({ kind: z.literal(kind), ...candidateFields, location: SourceLocationSchema });

/**
 * One source claim the guest observed. A `file-hint` has no location field at
 * all, so a file-only hint cannot be presented as a line by any consumer that
 * accepts this schema.
 */
export const SourceCandidateSchema = z.discriminatedUnion("kind", [
  positionedCandidate("element-creation"),
  positionedCandidate("component-invocation"),
  positionedCandidate("component-definition"),
  positionedCandidate("template-location"),
  z.strictObject({ kind: z.literal("file-hint"), ...candidateFields }),
]);
export type SourceCandidate = z.infer<typeof SourceCandidateSchema>;
