import {
  ASCII_WHITESPACE,
  decodeEntities,
  escapeAttributeValue,
  hasUnwritableCharacter,
} from "./escape.js";
import type { QuoteStyle } from "./escape.js";

/**
 * Whole-token algebra over the raw text of a literal `class` value.
 *
 * The value is modelled as an alternating list of gaps and tokens rather than
 * as a token array, because the gaps are user formatting: a class list wrapped
 * across three indented lines must come back wrapped across three indented
 * lines, and a value that was `" a  b "` inside its quotes must keep both the
 * padding and the double space. Rebuilding from `tokens.join(" ")` is a reflow,
 * and a reflow of an attribute nobody asked to reformat is a diff the user has
 * to review for no reason.
 *
 * Padding at the two ends is held separately from the gaps between tokens, so
 * an addition lands before the trailing padding and removing the first token
 * does not eat the leading indentation.
 *
 * Tokens keep their source spelling verbatim. Comparison happens on the decoded
 * form, so `[&amp;>*]:p-2` in the file and `[&>*]:p-2` from the inspector are
 * recognised as the same token — but a token that survives an edit is copied,
 * never re-encoded.
 */

export interface Segment {
  kind: "gap" | "token";
  raw: string;
}

export type ClassTokenError =
  | { code: "empty-token" }
  | { code: "whitespace-in-token"; token: string }
  | { code: "unwritable-character"; token: string };

const ASCII_WHITESPACE_RUN = /[ \t\n\f\r]+/g;
const ENTITY = /&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g;

/**
 * Splits a raw class value into alternating gaps and tokens.
 *
 * An entity that decodes to ASCII whitespace is a gap, not part of a token: the
 * browser sees `a&#32;b` as the two classes `a` and `b`, so a token model that
 * reads it as one token would report `b` absent and add a duplicate. `&nbsp;`
 * is deliberately not a gap — HTML splits class lists on ASCII whitespace only.
 */
export function splitClassValue(raw: string): Segment[] {
  const segments: Segment[] = [];
  ASCII_WHITESPACE_RUN.lastIndex = 0;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = ASCII_WHITESPACE_RUN.exec(raw)) !== null) {
    if (match.index > cursor) pushSplitOnEntityGaps(segments, raw.slice(cursor, match.index));
    segments.push({ kind: "gap", raw: match[0] });
    cursor = match.index + match[0].length;
  }
  if (cursor < raw.length) pushSplitOnEntityGaps(segments, raw.slice(cursor));
  return coalesceGaps(segments);
}

function pushSplitOnEntityGaps(segments: Segment[], run: string): void {
  ENTITY.lastIndex = 0;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = ENTITY.exec(run)) !== null) {
    const decoded = decodeEntities(match[0]);
    if (decoded === match[0] || !isAsciiWhitespace(decoded)) continue;
    if (match.index > cursor) segments.push({ kind: "token", raw: run.slice(cursor, match.index) });
    segments.push({ kind: "gap", raw: match[0] });
    cursor = match.index + match[0].length;
  }
  if (cursor < run.length) segments.push({ kind: "token", raw: run.slice(cursor) });
}

/** Adjacent gaps are one separator; merging keeps the bytes and simplifies removal. */
function coalesceGaps(segments: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const segment of segments) {
    const last = out[out.length - 1];
    if (segment.kind === "gap" && last?.kind === "gap") last.raw += segment.raw;
    else out.push({ ...segment });
  }
  return out;
}

function isAsciiWhitespace(value: string): boolean {
  if (value.length === 0) return false;
  for (const char of value) if (!ASCII_WHITESPACE.test(char)) return false;
  return true;
}

export function validateToken(token: string): ClassTokenError | null {
  if (token.length === 0) return { code: "empty-token" };
  if (ASCII_WHITESPACE.test(token)) return { code: "whitespace-in-token", token };
  if (hasUnwritableCharacter(token)) return { code: "unwritable-character", token };
  return null;
}

/**
 * Applies `add` and `remove` to the raw class value and returns the new raw
 * value. Adding a token already present is a no-op for that token; removing one
 * that is absent is a no-op for that token. Removal matches the whole decoded
 * token — `p-6` never matches `px-6`.
 */
export function applyClassTokenChange(
  raw: string,
  change: { add: readonly string[]; remove: readonly string[] },
  quote: QuoteStyle
): string {
  const segments = splitClassValue(raw);
  const last = segments.length - 1;
  const leading = segments[0]?.kind === "gap" ? segments[0]!.raw : "";
  const trailing = last > 0 && segments[last]!.kind === "gap" ? segments[last]!.raw : "";
  const core = segments.slice(leading === "" ? 0 : 1, trailing === "" ? undefined : last);

  const removing = new Set(change.remove);
  const kept: Segment[] = [];
  for (let i = 0; i < core.length; i++) {
    const segment = core[i]!;
    if (segment.kind !== "token" || !removing.has(decodeEntities(segment.raw))) {
      kept.push(segment);
      continue;
    }
    // Drop one neighbouring gap with the token so the survivors keep single
    // separators. Nothing reachable here is the value's outer padding — that
    // was split off before the loop.
    if (kept.length > 0 && kept[kept.length - 1]!.kind === "gap") kept.pop();
    else if (core[i + 1]?.kind === "gap") i++;
  }

  const present = new Set(kept.filter((s) => s.kind === "token").map((s) => decodeEntities(s.raw)));
  const separator = interTokenSeparator(core);
  for (const token of change.add) {
    if (present.has(token)) continue;
    present.add(token);
    if (kept.some((s) => s.kind === "token")) kept.push({ kind: "gap", raw: separator });
    kept.push({ kind: "token", raw: escapeAttributeValue(token, quote) });
  }

  // Padding around nothing is not formatting worth keeping, and an attribute
  // holding pure whitespace reads as a class list the editor mangled.
  if (!kept.some((s) => s.kind === "token")) return "";
  return leading + kept.map((s) => s.raw).join("") + trailing;
}

/**
 * The separator to use when appending: whichever gap already sat between two
 * tokens, so a value broken across lines gains its new token on a new line.
 */
function interTokenSeparator(core: Segment[]): string {
  for (let i = core.length - 1; i > 0; i--) {
    const segment = core[i]!;
    if (segment.kind === "gap" && core[i - 1]?.kind === "token" && core[i + 1]?.kind === "token") {
      return segment.raw;
    }
  }
  return " ";
}
