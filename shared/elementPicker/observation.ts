import { z } from "zod";
import { ComponentChainSchema } from "./component.js";
import { EVIDENCE_LIMITS, FrameworkEvidenceSchema } from "./evidence.js";
import { ElementPickerFrameworkSchema, PickerIdSchema, SourceCandidateSchema } from "./source.js";

/** Ceilings the guest builds to and the host enforces; the guest marks what it cut. */
export const ELEMENT_CONTEXT_LIMITS = {
  selector: 512,
  markup: 2048,
  styles: 40,
  property: 64,
  value: 256,
} as const;

export const OBSERVATION_LIMITS = {
  label: 200,
  tagName: 64,
  bounds: 32,
  candidates: 16,
  detections: 8,
  signals: 16,
} as const;

/**
 * Chromium's layout saturates near 2^25 px (a 32-bit fixed-point unit with six
 * fractional bits), so no rendered box lies past it, and a page-supplied rect
 * that does would turn edge arithmetic into Infinity.
 */
export const MAX_LAYOUT_PX = 2 ** 25;

export const RectSchema = z.strictObject({
  x: z.number().min(-MAX_LAYOUT_PX).max(MAX_LAYOUT_PX),
  y: z.number().min(-MAX_LAYOUT_PX).max(MAX_LAYOUT_PX),
  width: z.number().nonnegative().max(MAX_LAYOUT_PX),
  height: z.number().nonnegative().max(MAX_LAYOUT_PX),
});
export type Rect = z.infer<typeof RectSchema>;

/**
 * An element as the page shows it: a selector that finds it now, an excerpt of
 * its markup with values and embedded payloads stripped, and the computed
 * styles that say something about it. The selector is how a reader finds the
 * element, not what it is: the same element keeps its `elementId` while its
 * selector changes under it.
 */
export const ElementContextSchema = z.strictObject({
  selector: z.string().min(1).max(ELEMENT_CONTEXT_LIMITS.selector),
  markup: z.string().max(ELEMENT_CONTEXT_LIMITS.markup),
  markupTruncated: z.literal(true).optional(),
  styles: z
    .array(
      z.strictObject({
        property: z.string().min(1).max(ELEMENT_CONTEXT_LIMITS.property),
        value: z.string().max(ELEMENT_CONTEXT_LIMITS.value),
      })
    )
    .max(ELEMENT_CONTEXT_LIMITS.styles),
});
export type ElementContext = z.infer<typeof ElementContextSchema>;

/**
 * What a cheap detector saw that made it name a framework: a global, an
 * expando on a node, an attribute, or a hit in a bounded sample of the
 * document. The signals are the evidence; the framework is only the reading.
 */
export const FrameworkDetectionSchema = z.strictObject({
  framework: ElementPickerFrameworkSchema,
  signals: z
    .array(
      z.strictObject({
        via: z.enum(["global", "expando", "attribute", "document-sample"]),
        name: z.string().min(1).max(128),
      })
    )
    .min(1)
    .max(OBSERVATION_LIMITS.signals),
});
export type FrameworkDetection = z.infer<typeof FrameworkDetectionSchema>;

/**
 * Whether this observation can offer something, so the UI can say what a
 * framework does not give us instead of leaving it blank. `unknown` is not yet
 * established (a line waiting on the host to map a frame); `unavailable` was
 * looked for and is not there, with a code saying why rather than page text.
 */
export const CapabilitySchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("available") }),
  z.strictObject({ state: z.literal("unknown") }),
  z.strictObject({
    state: z.literal("unavailable"),
    reason: z.enum(["not-exposed", "production-build", "no-framework", "unmapped"]),
  }),
]);
export type Capability = z.infer<typeof CapabilitySchema>;

export const CapabilitiesSchema = z.strictObject({
  names: CapabilitySchema,
  chain: CapabilitySchema,
  componentSelection: CapabilitySchema,
  file: CapabilitySchema,
  line: CapabilitySchema,
  exactRange: CapabilitySchema,
});
export type Capabilities = z.infer<typeof CapabilitiesSchema>;

const observationFields = {
  elementId: PickerIdSchema,
  tagName: z.string().min(1).max(OBSERVATION_LIMITS.tagName),
  /** The page's own words for the element. Quoted as data everywhere it is shown or forwarded. */
  label: z.string().max(OBSERVATION_LIMITS.label),
  bounds: z.array(RectSchema).max(OBSERVATION_LIMITS.bounds),
  detections: z.array(FrameworkDetectionSchema).max(OBSERVATION_LIMITS.detections),
  componentChain: ComponentChainSchema,
  sourceCandidates: z.array(SourceCandidateSchema).max(OBSERVATION_LIMITS.candidates),
  capabilities: CapabilitiesSchema,
  frameworkEvidence: z.array(FrameworkEvidenceSchema).max(EVIDENCE_LIMITS.entries),
};

/**
 * Resolution results point back at a candidate by id, so an id has to name one
 * claim across the element and every component in its chain.
 */
export function requireUniqueCandidateIds(
  observation: {
    sourceCandidates: readonly { candidateId: string }[];
    componentChain: {
      components: readonly { sourceCandidates: readonly { candidateId: string }[] }[];
    };
  },
  ctx: z.RefinementCtx
): void {
  const ids = [
    ...observation.sourceCandidates,
    ...observation.componentChain.components.flatMap((record) => record.sourceCandidates),
  ].map((candidate) => candidate.candidateId);
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: "custom", message: "candidate ids must be unique within an observation" });
  }
}

/** What labels a highlight. No context: hover never pays for a computed-style read or a markup walk. */
export const HoverObservationSchema = z
  .strictObject({ phase: z.literal("hover"), ...observationFields })
  .superRefine(requireUniqueCandidateIds);
export type HoverObservation = z.infer<typeof HoverObservationSchema>;

export const SelectionObservationSchema = z
  .strictObject({
    phase: z.literal("selection"),
    ...observationFields,
    /** Absent when the guest could not read it; never present on a hover. */
    context: ElementContextSchema.optional(),
  })
  .superRefine(requireUniqueCandidateIds);
export type SelectionObservation = z.infer<typeof SelectionObservationSchema>;

export const ElementObservationSchema = z.discriminatedUnion("phase", [
  HoverObservationSchema,
  SelectionObservationSchema,
]);
export type ElementObservation = z.infer<typeof ElementObservationSchema>;
