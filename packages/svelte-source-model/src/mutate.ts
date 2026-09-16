import type { Replacement } from "./splice.js";
import type { ResolvedElement, SourceRange, SvelteParse } from "./types.js";

/**
 * Turns an intent into a set of replacements over the original source, or
 * refuses. Planning and applying are deliberately separate: a plan can be shown
 * to the user, checked for shared impact, and validated by re-parsing the
 * candidate source before anything reaches disk.
 */

export type MutationFailureReason =
  | "unsupported-surface"
  | "invalid-class-token"
  | "invalid-attribute-value"
  | "candidate-parse-failed"
  | "protected-range-modified"
  | "no-op";

export type MutationPlan =
  | { status: "planned"; replacements: Replacement[]; before: string; after: string }
  | { status: "refused"; reason: MutationFailureReason; detail?: string };

/** Replace the element's single literal text child. */
export function planSetLiteralText(
  _source: string,
  _element: ResolvedElement,
  _text: string
): MutationPlan {
  throw new Error("planSetLiteralText is not implemented yet");
}

/**
 * Add and remove whole class tokens on a literal `class` attribute.
 *
 * Token-level, never string-level: unrelated utilities, custom classes and
 * variant chains the builder does not recognise must survive untouched. Removal
 * matches a token exactly — no prefix matching, which would eat `px-6` while
 * removing `p-6`.
 */
export function planSetClassTokens(
  _source: string,
  _element: ResolvedElement,
  _change: { add: readonly string[]; remove: readonly string[] }
): MutationPlan {
  throw new Error("planSetClassTokens is not implemented yet");
}

/** Set a literal attribute value, preserving quote style and escaping correctly. */
export function planSetLiteralAttribute(
  _source: string,
  _element: ResolvedElement,
  _name: string,
  _value: string
): MutationPlan {
  throw new Error("planSetLiteralAttribute is not implemented yet");
}

/** Set a literal scalar prop at a component invocation. */
export function planSetLiteralProp(
  _source: string,
  _element: ResolvedElement,
  _name: string,
  _value: string | number | boolean
): MutationPlan {
  throw new Error("planSetLiteralProp is not implemented yet");
}

/**
 * Re-parses candidate source and proves the plan did what it claimed: the
 * intended range changed, and every range in `protectedRanges` still holds
 * byte-identical content. A plan that cannot be verified is refused — the
 * candidate never reaches disk just to find out whether it compiles.
 */
export function verifyCandidate(
  _original: string,
  _candidate: string,
  _protectedRanges: readonly SourceRange[],
  _parse: SvelteParse
): { ok: true } | { ok: false; reason: MutationFailureReason; detail?: string } {
  throw new Error("verifyCandidate is not implemented yet");
}
