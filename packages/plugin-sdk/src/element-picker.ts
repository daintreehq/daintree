/// <reference lib="dom" />
/**
 * `@daintreehq/plugin-sdk/element-picker` — both halves of an Element Picker
 * provider (`contributes.elementPickerProviders`): the guest extractor and the
 * optional source resolver.
 *
 * A provider's `guestEntry` is a standalone browser script the host evaluates
 * in a previewed page, only after the provider's declarative detector matched
 * it and only for as long as the plugin stays enabled. It runs in the page's
 * own world and has no access to the plugin worker, Node or the host API, so it
 * reads what the page already exposes and returns data. Build it with
 * `daintreePlugin({ target: "guest" })` from `@daintreehq/plugin-vite`.
 *
 * Do not `eval`, build functions from strings or inject script tags: the page's
 * CSP applies to those, and the host loads the entry with that in mind.
 */

import type { ComponentChain } from "../../../shared/elementPicker/component.js";
import type { FrameworkEvidence } from "../../../shared/elementPicker/evidence.js";
import type { Capabilities } from "../../../shared/elementPicker/observation.js";
import type { SourceCandidate } from "../../../shared/elementPicker/source.js";
import type {
  ResolveRequest,
  ResolveResponse,
  ResolverSourceAccess,
} from "../../../shared/elementPicker/resolver.js";

export type {
  MapSourceLocation,
  ResolveRequest,
  ResolveResponse,
  ResolverSourceAccess,
  RevisionedSource,
  RevisionedSourceMap,
  SourceAccessResult,
} from "../../../shared/elementPicker/resolver.js";
export type {
  FileRevision,
  ResolutionResult,
  SourceFileRef,
  UnavailableReason,
} from "../../../shared/elementPicker/resolution.js";

/** `hover` runs inside a pointer move, so read only what labels a highlight; do costly work on `selection`. */
export type ElementPickerPhase = "hover" | "selection";

/** Notices the host turns into a status line for the person picking; the page's own text never reaches it. */
export type ElementPickerNotice = "not-dev-build" | "metadata-unavailable" | "ancestry-truncated";

/**
 * How firmly the extractor claims the element it describes. `direct` is the
 * framework's own stamp on the element; `fallback` is a description given only
 * for want of a better one.
 */
export type ElementPickerOwnership = "direct" | "fallback";

/** What one provider adds to an observation; every field is optional. */
export interface ElementPickerContribution {
  componentChain?: ComponentChain;
  sourceCandidates?: SourceCandidate[];
  frameworkEvidence?: FrameworkEvidence[];
  capabilities?: Capabilities;
  ownership?: ElementPickerOwnership;
}

/** Names elements in a reply: pass any element to `ref` and put the token it returns in the reply. */
export interface ElementPickerRefs {
  ref(node: Element): string | null;
}

export interface ElementPickerExtractor {
  /**
   * Synchronous and bounded. Null says it looked and found nothing of its own;
   * throw when it cannot look, and it gives no answer either way.
   */
  extract(
    element: Element,
    phase: ElementPickerPhase,
    refs: ElementPickerRefs
  ): ElementPickerContribution | null;
  /** True for an extractor that reads nothing on hover. */
  selectionOnly?: boolean;
  /** For a framework that selects something other than the node the pointer landed on. */
  pick?(
    hit: Element,
    refs: ElementPickerRefs
  ): { target: Element; data: ElementPickerContribution | null } | null;
  /** Elements found by a query in the framework's own terms. */
  locate?(
    query: unknown,
    anchor: Element | null
  ): { elements: Element[]; data?: Record<string, unknown> } | null;
  /** Called once on registration with the way to tell the picker about the page. */
  start?(notify: (notice: ElementPickerNotice) => void): void;
  /** Called when the provider is disabled, uninstalled or the picker closes. */
  dispose?(): void;
}

/** Called once per document with the provider id the host registered, `{plugin}.{id}`. */
export type ElementPickerExtractorFactory = (providerId: string) => ElementPickerExtractor;

/**
 * Marks a guest entry's default export. An identity function that exists for
 * the types: the host calls the factory itself, and only after detection.
 *
 * ```ts
 * export default defineElementPickerExtractor(() => ({
 *   extract(element) { ... },
 * }));
 * ```
 */
export function defineElementPickerExtractor(
  factory: ElementPickerExtractorFactory
): ElementPickerExtractorFactory {
  return factory;
}

/**
 * A provider's source resolver: given the candidates its extractor reported for
 * a selection, it says which file and line each one is, holding every claim to
 * bytes it read. The host sends only this provider's candidates and answers
 * any it leaves out as `unsupported`.
 */
export interface ElementPickerResolver {
  /**
   * Echo `requestId` and `documentEpoch`, and answer only the elements and
   * candidates you were sent: an answer that names anything else is dropped
   * whole. Stop when `signal` aborts.
   */
  resolve(
    request: ResolveRequest,
    access: ResolverSourceAccess,
    signal: AbortSignal
  ): Promise<ResolveResponse>;
}

/** Called once per resolver process with the provider id the host registered, `{plugin}.{id}`. */
export type ElementPickerResolverFactory = (providerId: string) => ElementPickerResolver;

/**
 * Marks a `resolverEntry` module's default export. An identity function that
 * exists for the types: the host calls the factory itself, in a process of the
 * plugin's own that starts on the first selection needing it and exits after
 * 30 seconds without one.
 *
 * Every read goes through `access`, which the host answers under the
 * workspace's containment, the preview's origin and the request's budget. A
 * revision you return must be one `access` gave you in this request.
 *
 * ```ts
 * export default defineElementPickerResolver(() => ({
 *   async resolve(request, access, signal) { ... },
 * }));
 * ```
 */
export function defineElementPickerResolver(
  factory: ElementPickerResolverFactory
): ElementPickerResolverFactory {
  return factory;
}
