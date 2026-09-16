import { applyReplacements, isNoOp } from "./splice.js";
import type { Replacement } from "./splice.js";
import type { ResolvedElement, SourceRange, SurfaceSupport, SvelteParse } from "./types.js";
import {
  escapeAttributeValue,
  escapeTextContent,
  hasUnwritableCharacter,
  normaliseLineEndings,
} from "./mutate/escape.js";
import type { QuoteStyle } from "./mutate/escape.js";
import { applyClassTokenChange, validateToken } from "./mutate/classTokens.js";
import { classifyValueSlot, expressionLiteralKind, needsQuoting } from "./mutate/slots.js";
import type { ValueSlot } from "./mutate/slots.js";
import { complementOf, verifyProtectedRanges } from "./mutate/verify.js";

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

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function refuse(reason: MutationFailureReason, detail?: string): MutationPlan {
  return detail === undefined
    ? { status: "refused", reason }
    : { status: "refused", reason, detail };
}

function directRange(
  surface: SurfaceSupport | undefined,
  what: string
): SourceRange | MutationPlan {
  if (surface === undefined) return refuse("unsupported-surface", `${what} is absent`);
  if (surface.support !== "direct") return refuse("unsupported-surface", surface.reason);
  return surface.range;
}

function isPlan(value: SourceRange | MutationPlan): value is MutationPlan {
  return "status" in value;
}

/**
 * Splices the replacements, proves nothing outside them moved, and packages the
 * result. `before` and `after` are whole-file blobs: a plan has to carry enough
 * to be inverted after the fact, and a journal entry holding only the new
 * fragment cannot restore a file whose other bytes have since been rewritten.
 */
function sealPlan(source: string, replacements: Replacement[]): MutationPlan {
  if (isNoOp(source, replacements)) return refuse("no-op");

  let after: string;
  try {
    after = applyReplacements(source, replacements);
  } catch (error) {
    return refuse("protected-range-modified", describeError(error));
  }

  // `isNoOp` asks whether each replacement restates its own bytes, which two
  // replacements that cancel each other out can pass while still changing
  // nothing. The spliced result is the only answer that cannot be gamed.
  if (after === source) return refuse("no-op");

  const verdict = verifyProtectedRanges(source, after, complementOf(source.length, replacements));
  if (!verdict.ok) return refuse("protected-range-modified", verdict.detail);

  return { status: "planned", replacements, before: source, after };
}

/**
 * Elements whose content is raw text rather than escapable text. Writing
 * `&amp;` into one of these is not an escape, it is five visible characters,
 * and `<` inside them cannot be represented at all — so there is no encoding to
 * fall back to and the only honest answer is to refuse.
 *
 * `textarea` and `title` are deliberately absent: those are *escapable* raw
 * text, where entities decode exactly as they do in a normal text node.
 */
const RAW_TEXT_ELEMENTS = new Set([
  "script",
  "style",
  "xmp",
  "iframe",
  "noembed",
  "noframes",
  "noscript",
  "plaintext",
]);

/**
 * Elements whose HTML parser discards a newline that immediately follows the
 * open tag. Writing "\nhello" into a `<pre>` renders "hello", so the newline has
 * to be doubled to survive — the standard serialisation workaround, and the
 * only place in this file where the correct output is not the literal input.
 */
const NEWLINE_EATING_ELEMENTS = new Set(["pre", "textarea", "listing"]);

/** Replace the element's single literal text child. */
export function planSetLiteralText(
  source: string,
  element: ResolvedElement,
  text: string
): MutationPlan {
  if (RAW_TEXT_ELEMENTS.has(element.tagName.toLowerCase())) {
    return refuse("unsupported-surface", `<${element.tagName}> holds raw text, not escapable text`);
  }
  const range = directRange(element.text, "literal text");
  if (isPlan(range)) return range;

  if (hasUnwritableCharacter(text)) {
    return refuse("invalid-attribute-value", "text contains a control character");
  }

  const normalised = normaliseLineEndings(text, source);
  const leadingNewline = /^\r?\n/.exec(normalised)?.[0];
  const preserved =
    leadingNewline !== undefined &&
    NEWLINE_EATING_ELEMENTS.has(element.tagName.toLowerCase()) &&
    source[range.start - 1] === ">"
      ? leadingNewline + normalised
      : normalised;

  return sealPlan(source, [
    { start: range.start, end: range.end, text: escapeTextContent(preserved) },
  ]);
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
  source: string,
  element: ResolvedElement,
  change: { add: readonly string[]; remove: readonly string[] }
): MutationPlan {
  const range = directRange(element.classes, "class attribute");
  if (isPlan(range)) return range;

  for (const token of [...change.add, ...change.remove]) {
    const error = validateToken(token);
    if (error) return refuse("invalid-class-token", `${error.code}: ${JSON.stringify(token)}`);
  }

  // Both sides asking for the same token is a caller bug, and the two readings
  // of it disagree: removal-then-addition silently moves the token to the end
  // of the list. Refusing is the only answer that cannot surprise anyone.
  const contested = change.add.filter((token) => change.remove.includes(token));
  if (contested.length > 0) {
    return refuse(
      "invalid-class-token",
      `added and removed in one change: ${contested.join(", ")}`
    );
  }

  const slot = classifyValueSlot(source, range);
  if (slot.kind === "expression" || slot.kind === "unknown") {
    return refuse("unsupported-surface", "class value is not a literal string");
  }

  const raw = source.slice(slot.inner.start, slot.inner.end);
  const quote: QuoteStyle = slot.kind === "quoted" ? slot.quote : '"';
  const next = applyClassTokenChange(raw, change, quote);
  if (next === raw) return refuse("no-op");

  // An unquoted `class=grid` that gains a second token has to become quoted;
  // the replacement widens to carry the quotes rather than emitting `class=a b`.
  const text = slot.kind === "unquoted" && needsQuoting(next) ? `${quote}${next}${quote}` : next;
  return sealPlan(source, [{ start: slot.inner.start, end: slot.inner.end, text }]);
}

/** Set a literal attribute value, preserving quote style and escaping correctly. */
export function planSetLiteralAttribute(
  source: string,
  element: ResolvedElement,
  name: string,
  value: string
): MutationPlan {
  const range = directRange(element.attributes[name], `attribute ${name}`);
  if (isPlan(range)) return range;
  return planScalarValue(source, range, value);
}

/** Set a literal scalar prop at a component invocation. */
export function planSetLiteralProp(
  source: string,
  element: ResolvedElement,
  name: string,
  value: string | number | boolean
): MutationPlan {
  if (element.kind !== "Component") {
    return refuse("unsupported-surface", "not-a-component");
  }
  const range = directRange(element.props[name], `prop ${name}`);
  if (isPlan(range)) return range;
  return planScalarValue(source, range, value);
}

/**
 * Writes a scalar into a value slot without changing what kind of value it is.
 *
 * A component's prop type is part of its contract: turning `tier={3}` into
 * `tier="4"` hands the component a string where its default was a number, and
 * nothing in the markup says so. The refusal is the point — the caller either
 * sends a value of the right type or falls back to the agent.
 */
function planScalarValue(
  source: string,
  range: SourceRange,
  value: string | number | boolean
): MutationPlan {
  const slot = classifyValueSlot(source, range);
  if (slot.kind === "unknown") {
    return refuse("unsupported-surface", "value is not a literal slot");
  }

  // What the slot holds today, not what its delimiters look like: `tier={"3"}`
  // is an expression slot holding a string, and writing 7 into it would hand
  // the component a number its default never was.
  const held =
    slot.kind === "expression"
      ? expressionLiteralKind(source.slice(slot.inner.start, slot.inner.end))
      : "string";
  if (held === "unknown") {
    return refuse("unsupported-surface", "slot does not hold a plain literal");
  }
  if (held !== typeof value) {
    return refuse(
      "invalid-attribute-value",
      `slot holds a ${held}; writing a ${typeof value} would change the prop's type`
    );
  }

  if (typeof value === "string") {
    if (hasUnwritableCharacter(value)) {
      return refuse("invalid-attribute-value", "value contains a control character");
    }
    return sealPlan(source, [writeString(source, slot, value)]);
  }

  if (typeof value === "number" && !Number.isFinite(value)) {
    return refuse("invalid-attribute-value", `${value} is not a finite number`);
  }
  // `String(-0)` is "0", which is a different literal from the one asked for.
  const text = Object.is(value, -0) ? "-0" : String(value);
  return sealPlan(source, [{ start: slot.inner.start, end: slot.inner.end, text }]);
}

function writeString(
  source: string,
  slot: Exclude<ValueSlot, { kind: "unknown" }>,
  value: string
): Replacement {
  if (slot.kind === "expression") {
    // The value goes in unnormalised: inside a JavaScript literal a newline is
    // the two characters `\n`, so rewriting it to `\r\n` for a CRLF file would
    // change what the component receives without moving a single line break in
    // the file. JSON.stringify is exactly JavaScript's string-literal grammar
    // for everything that matters here, lone surrogates included.
    return { start: slot.inner.start, end: slot.inner.end, text: JSON.stringify(value) };
  }
  const normalised = normaliseLineEndings(value, source);
  if (slot.kind === "quoted") {
    return {
      start: slot.inner.start,
      end: slot.inner.end,
      text: escapeAttributeValue(normalised, slot.quote),
    };
  }
  const quote: QuoteStyle = '"';
  const escaped = escapeAttributeValue(normalised, quote);
  return {
    start: slot.inner.start,
    end: slot.inner.end,
    text: needsQuoting(normalised) ? `${quote}${escaped}${quote}` : escaped,
  };
}

/**
 * Re-parses candidate source and proves the plan did what it claimed: the
 * intended range changed, and every range in `protectedRanges` still holds
 * byte-identical content. A plan that cannot be verified is refused — the
 * candidate never reaches disk just to find out whether it parses.
 *
 * This is a parse-and-range gate, not a compile gate: the candidate can parse
 * and still fail `compile`, as setting `type` to `text` on an input that carries
 * `bind:checked` does. A caller that promises compilability has to run the
 * compiler itself.
 *
 * The protected-range check is conservative in one direction only. It derives
 * the edit from the two strings, so a candidate whose change coincides with the
 * source's own repetition can be refused although its protected bytes are
 * intact; it can never accept one whose protected bytes changed.
 */
export function verifyCandidate(
  original: string,
  candidate: string,
  protectedRanges: readonly SourceRange[],
  parse: SvelteParse
): { ok: true } | { ok: false; reason: MutationFailureReason; detail?: string } {
  if (candidate === original) return { ok: false, reason: "no-op" };

  try {
    parse(candidate, { modern: true });
  } catch (error) {
    return {
      ok: false,
      reason: "candidate-parse-failed",
      detail: describeError(error),
    };
  }

  const verdict = verifyProtectedRanges(original, candidate, protectedRanges);
  if (!verdict.ok) return { ok: false, reason: "protected-range-modified", detail: verdict.detail };

  return { ok: true };
}
