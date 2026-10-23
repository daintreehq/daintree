/// <reference lib="dom" />
/**
 * `@daintreehq/plugin-sdk/element-picker` — the guest half of an Element Picker
 * provider (`contributes.elementPickerProviders`).
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
