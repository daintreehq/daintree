import type { SourceRange } from "../types.js";
import type { QuoteStyle } from "./escape.js";

/**
 * What kind of source slot a value range sits in.
 *
 * The resolver hands over a range covering an attribute or prop *value*. How
 * that value has to be written depends on what surrounds it, and the bytes
 * either side of the range are the only honest evidence: a quoted slot takes
 * escaped text, an expression slot takes a JavaScript literal, and writing one
 * into the other silently changes the prop's type.
 *
 * Both brace conventions are accepted because Svelte's own AST offers both — an
 * `ExpressionTag` spans `{3}` while its inner `Literal` spans `3` — and this
 * package must not care which one the resolver chose to report.
 */
export type ValueSlot =
  | { kind: "quoted"; quote: QuoteStyle; inner: SourceRange }
  | { kind: "unquoted"; inner: SourceRange }
  | { kind: "expression"; inner: SourceRange }
  | { kind: "unknown" };

const QUOTES = new Set(['"', "'"]);

export function classifyValueSlot(source: string, range: SourceRange): ValueSlot {
  if (range.start < 0 || range.end > source.length || range.end < range.start) {
    return { kind: "unknown" };
  }

  const before = source[range.start - 1];
  const after = source[range.end];

  if (before !== undefined && QUOTES.has(before) && after === before) {
    return { kind: "quoted", quote: before as QuoteStyle, inner: range };
  }
  // Scan past padding: `tier={ 3 }` reported as the inner `3` still sits in an
  // expression slot, and refusing it would make a legal literal prop look
  // dynamic purely because someone spaced it out.
  if (skipSpaceBack(source, range.start) === "{" && skipSpaceForward(source, range.end) === "}") {
    return { kind: "expression", inner: range };
  }
  // A range reported as the whole `{…}` tag rather than its interior.
  if (
    source[range.start] === "{" &&
    source[range.end - 1] === "}" &&
    range.end - range.start >= 2
  ) {
    return { kind: "expression", inner: { start: range.start + 1, end: range.end - 1 } };
  }
  if (
    before === "=" &&
    range.end > range.start &&
    !/[\s"'`<>=]/.test(source.slice(range.start, range.end))
  ) {
    return { kind: "unquoted", inner: range };
  }
  return { kind: "unknown" };
}

function skipSpaceBack(source: string, from: number): string | undefined {
  let index = from - 1;
  while (index >= 0 && /\s/.test(source[index]!)) index--;
  return source[index];
}

function skipSpaceForward(source: string, from: number): string | undefined {
  let index = from;
  while (index < source.length && /\s/.test(source[index]!)) index++;
  return source[index];
}

/**
 * True when a plain-text value can no longer live in an unquoted attribute.
 *
 * HTML's unquoted form ends at the first space, so widening to a quoted value
 * is the only correct answer rather than an optional tidy-up. A trailing `/` is
 * the subtle one: in `<img alt=logo/>` the slash belongs to the value, not to
 * the self-closing tag, and the element silently stops closing itself.
 */
export function needsQuoting(value: string): boolean {
  return value === "" || value.endsWith("/") || /[\s"'`<>=]/.test(value);
}

/**
 * The kind of JavaScript literal an expression slot currently holds, judged
 * from its source text alone.
 *
 * A component's prop type is part of its contract, and the delimiter shape does
 * not prove it: `tier={3}` and `tier={"3"}` are both expression slots but only
 * one of them is a number. Anything that is not a plain literal is `"unknown"`,
 * which the planner refuses rather than guesses at.
 */
export function expressionLiteralKind(text: string): "string" | "number" | "boolean" | "unknown" {
  const trimmed = text.trim();
  if (trimmed === "") return "unknown";
  if (trimmed === "true" || trimmed === "false") return "boolean";
  const first = trimmed[0]!;
  const last = trimmed[trimmed.length - 1]!;
  if ((first === '"' || first === "'" || first === "`") && last === first && trimmed.length >= 2) {
    return "string";
  }
  if (/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(trimmed)) return "number";
  return "unknown";
}
