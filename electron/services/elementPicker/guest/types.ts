/**
 * Types the guest assets share. Type-only imports from `shared/elementPicker`:
 * a value import would bundle zod and every schema into the page.
 */

import type { ComponentChain } from "../../../../shared/elementPicker/component.js";
import type { FrameworkEvidence } from "../../../../shared/elementPicker/evidence.js";
import type { Capabilities } from "../../../../shared/elementPicker/observation.js";
import type { ElementPickerEvent } from "../../../../shared/elementPicker/protocol.js";
import type { SourceCandidate } from "../../../../shared/elementPicker/source.js";

export type PickerMode = "browse" | "select";

/**
 * How firmly an extractor claims the element it describes. `direct` is the
 * framework's own stamp on the element itself (an Astro source attribute, the
 * content of an Astro slot); `fallback` is a description given only for want
 * of a better one. Unmarked sits between them.
 */
export type ExtractorOwnership = "direct" | "fallback";

/**
 * Where a framework's reader stands in this document. `unavailable` is a
 * framework the enum allows but this build ships no reader for — a fact about
 * the app, not a failure of the page.
 */
export type ExtractorAvailability = "pending" | "installed" | "unavailable" | "failed";

/**
 * What the host has established about this document's readers, which the
 * isolated picker cannot see for itself: whether its first look at the page
 * finished, and what became of each framework it found. Until then, nothing
 * the picker could not read is reported as absent.
 */
export interface PickerAvailability {
  detection: "pending" | "settled";
  extractors: Partial<Record<string, ExtractorAvailability>>;
}

/**
 * What one framework's extractor adds to an observation. Every field is
 * optional: an extractor that can name a component but not place it leaves
 * the candidates out rather than inventing them.
 *
 * One contribution describes the element, whole: the bootstrap takes its
 * chain, candidates and capabilities from the highest-ranked one that has any,
 * the first of equals in install order, so ids within it only need to be
 * unique among themselves. Evidence is the exception, and comes from every
 * contribution about the same element (a pick another framework moved
 * elsewhere is not): a framework can say what surrounds the element (the
 * island a React tree hydrates in) without describing it, by sending evidence
 * alone.
 */
export interface ExtractorContribution {
  componentChain?: ComponentChain;
  sourceCandidates?: SourceCandidate[];
  frameworkEvidence?: FrameworkEvidence[];
  capabilities?: Capabilities;
  ownership?: ExtractorOwnership;
}

/** The half of the host prelude's `api` the bootstrap reads or replaces. */
export interface BootstrapHostApi {
  channel: string;
  mode: PickerMode;
  post(event: ElementPickerEvent): void;
  setMode(mode: PickerMode): void;
  clearSelection(): void;
  clearHover(): void;
  /** The host's account of this document's readers, replacing the last one. */
  setAvailability(availability: PickerAvailability): void;
  /** Select again by element id or a framework's locator; false when nothing was found. */
  reselect(request: unknown): boolean;
  dispose: (() => void) | null;
}
