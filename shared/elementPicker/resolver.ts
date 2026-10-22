import { z } from "zod";
import { COMPONENT_LIMITS, ComponentChainSchema } from "./component.js";
import { EVIDENCE_LIMITS, FrameworkEvidenceSchema } from "./evidence.js";
import {
  CapabilitiesSchema,
  OBSERVATION_LIMITS,
  SelectionObservationSchema,
  type FrameworkDetection,
} from "./observation.js";
import {
  FileRevisionSchema,
  ResolutionResultSchema,
  SourceFileRefSchema,
  type FileRevision,
  type SourceFileRef,
  type UnavailableReason,
} from "./resolution.js";
import {
  ElementPickerFrameworkSchema,
  PickerIdSchema,
  SourceCandidateSchema,
  type ElementPickerFramework,
} from "./source.js";

/* Guest side. Generic over the node type: shared code compiles without the DOM. */

export type ObservationPhase = "hover" | "selection";

/**
 * Lives in the bootstrap every bound page gets, so it must stay cheap: globals,
 * expandos and attributes on a bounded sample. Its result is what decides
 * whether the framework's extractor is injected at all.
 */
export interface GuestFrameworkDetector<TNode> {
  readonly framework: ElementPickerFramework;
  detect(sample: readonly TNode[]): FrameworkDetection | null;
}

/** Element identity is the bootstrap's; an extractor asks it for ids rather than minting its own. */
export interface GuestElementIdentity<TNode> {
  elementId(node: TNode): string;
}

export interface ComponentRoots<TNode> {
  roots: readonly TNode[];
  /** False when the walk stopped at its bound before it had every root. */
  complete: boolean;
}

/**
 * One framework's reader, injected only once its detector fired. `extract`
 * returns null for a node the framework does not own. On hover it reads only
 * what labels the highlight.
 */
export interface GuestFrameworkExtractor<TNode> {
  readonly framework: ElementPickerFramework;
  extract(
    node: TNode,
    phase: ObservationPhase,
    identity: GuestElementIdentity<TNode>
  ): FrameworkExtraction | null;
  /** The rendered roots of a component this extractor reported, for selecting the component itself. */
  componentRoots(componentId: string): ComponentRoots<TNode> | null;
}

/**
 * What an extractor hands the bootstrap. Extractors run in the page's world
 * where page code can reach them, so this crosses into the bootstrap as
 * untrusted data and is validated like anything else the page sends.
 */
export const FrameworkExtractionSchema = z.strictObject({
  framework: ElementPickerFrameworkSchema,
  componentChain: ComponentChainSchema,
  sourceCandidates: z.array(SourceCandidateSchema).max(OBSERVATION_LIMITS.candidates),
  frameworkEvidence: z.array(FrameworkEvidenceSchema).max(EVIDENCE_LIMITS.entries),
  capabilities: CapabilitiesSchema,
});
export type FrameworkExtraction = z.infer<typeof FrameworkExtractionSchema>;

/* Host side. */

/**
 * Hard ceilings on one resolve. A request may ask for less, never more. They
 * are declarations: the host's source access is what enforces them.
 */
export const RESOLVE_BUDGET_CEILINGS = {
  maxFiles: 32,
  /** The plugin's existing per-file read ceiling. */
  maxFileBytes: 1024 * 1024,
  maxNetworkRequests: 8,
  maxNetworkBytes: 4 * 1024 * 1024,
  deadlineMs: 5_000,
} as const;

export const ResolveBudgetSchema = z.strictObject({
  maxFiles: z.number().int().nonnegative().max(RESOLVE_BUDGET_CEILINGS.maxFiles),
  maxFileBytes: z.number().int().positive().max(RESOLVE_BUDGET_CEILINGS.maxFileBytes),
  maxNetworkRequests: z
    .number()
    .int()
    .nonnegative()
    .max(RESOLVE_BUDGET_CEILINGS.maxNetworkRequests),
  maxNetworkBytes: z.number().int().nonnegative().max(RESOLVE_BUDGET_CEILINGS.maxNetworkBytes),
  deadlineMs: z.number().int().positive().max(RESOLVE_BUDGET_CEILINGS.deadlineMs),
});
export type ResolveBudget = z.infer<typeof ResolveBudgetSchema>;

export const RESOLVE_LIMITS = {
  observations: 32,
  knownRevisions: 32,
  /** Every candidate an observation can carry: its own plus each component record's. */
  resultsPerObservation:
    OBSERVATION_LIMITS.candidates + COMPONENT_LIMITS.records * COMPONENT_LIMITS.candidates,
} as const;

/**
 * Selections only: a hover is never resolved. `knownRevisions` are the
 * revisions earlier results held at, so a changed file comes back `stale`
 * instead of quietly resolving somewhere new.
 */
export const ResolveRequestSchema = z.strictObject({
  requestId: PickerIdSchema,
  sessionId: z.string().min(1).max(128),
  documentEpoch: z.number().int().nonnegative(),
  /** Host-issued: the workspace whose authority every file read in this request is bounded by. */
  workspaceId: PickerIdSchema,
  observations: z.array(SelectionObservationSchema).min(1).max(RESOLVE_LIMITS.observations),
  knownRevisions: z
    .array(z.strictObject({ file: SourceFileRefSchema, revision: FileRevisionSchema }))
    .max(RESOLVE_LIMITS.knownRevisions),
  budget: ResolveBudgetSchema,
});
export type ResolveRequest = z.infer<typeof ResolveRequestSchema>;

export const ResolveResponseSchema = z.strictObject({
  requestId: PickerIdSchema,
  documentEpoch: z.number().int().nonnegative(),
  outcomes: z
    .array(
      z.strictObject({
        elementId: PickerIdSchema,
        results: z.array(ResolutionResultSchema).max(RESOLVE_LIMITS.resultsPerObservation),
      })
    )
    .max(RESOLVE_LIMITS.observations),
});
export type ResolveResponse = z.infer<typeof ResolveResponseSchema>;

/** A newer selection or a navigation supersedes the request; work not yet done reports `cancelled`. */
export const ResolveCancelSchema = z.strictObject({ requestId: PickerIdSchema });
export type ResolveCancel = z.infer<typeof ResolveCancelSchema>;

export type SourceAccessResult<T> =
  { ok: true; value: T } | { ok: false; reason: UnavailableReason };

export interface RevisionedSource {
  file: SourceFileRef;
  revision: FileRevision;
  bytes: Uint8Array;
}

export interface RevisionedSourceMap {
  /** Null when the map was inlined in the generated module. */
  url: string | null;
  revision: FileRevision;
  text: string;
}

/**
 * All the file and network access a resolver gets. The host implements both
 * and owns containment, origin policy, redirects and the request's budget, so
 * a resolver holds bytes and never a path or a socket it could take further.
 */
export interface ResolverSourceAccess {
  readSource(
    file: SourceFileRef,
    signal: AbortSignal
  ): Promise<SourceAccessResult<RevisionedSource>>;
  /** Finds the map for a generated module the preview served, inline or external. */
  fetchSourceMap(
    generatedUrl: string,
    signal: AbortSignal
  ): Promise<SourceAccessResult<RevisionedSourceMap>>;
}

/** Resolves the candidates of one framework; the host routes each candidate by its `framework`. */
export interface HostSourceResolver {
  readonly framework: ElementPickerFramework;
  resolve(
    request: ResolveRequest,
    access: ResolverSourceAccess,
    signal: AbortSignal
  ): Promise<ResolveResponse>;
}
