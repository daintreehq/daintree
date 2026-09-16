import { decodeEntities, escapeAttributeValue, hasUnwritableCharacter } from "./escape.js";
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
 * Tokens keep their source spelling verbatim. Comparison happens on the decoded
 * form, so `[&amp;>*]:p-2` in the file and `[&>*]:p-2` from the inspector are
 * recognised as the same token — but a token that survives an edit is copied,
 * never re-encoded.
 */

interface Segment {
  kind: "gap" | "token";
  raw: string;
}

export type ClassTokenError =
  | { code: "empty-token" }
  | { code: "whitespace-in-token"; token: string }
  | { code: "unwritable-character"; token: string };

const ENTITY = /&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g;

/**
 * Splits a raw class value into alternating gaps and tokens.
 *
 * An entity that decodes to whitespace is a gap, not part of a token: the
 * browser sees `a&#32;b` as the two classes `a` and `b`, so a token model that
 * reads it as one token would report `b` absent and add a duplicate.
 */
export function splitClassValue(raw: string): Segment[] {
  const segments: Segment[] = [];
  const pattern = /\s+/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    if (match.index > cursor) pushSplitOnEntityGaps(segments, raw.slice(cursor, match.index));
    segments.push({ kind: "gap", raw: match[0] });
    cursor = match.index + match[0].length;
  }
  if (cursor < raw.length) pushSplitOnEntityGaps(segments, raw.slice(cursor));
  return segments;
}

function pushSplitOnEntityGaps(segments: Segment[], run: string): void {
  ENTITY.lastIndex = 0;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = ENTITY.exec(run)) !== null) {
    const decoded = decodeEntities(match[0]);
    if (decoded === match[0] || decoded.trim() !== "") continue;
    if (match.index > cursor) segments.push({ kind: "token", raw: run.slice(cursor, match.index) });
    segments.push({ kind: "gap", raw: match[0] });
    cursor = match.index + match[0].length;
  }
  if (cursor < run.length) segments.push({ kind: "token", raw: run.slice(cursor) });
}

export function validateToken(token: string): ClassTokenError | null {
  if (token.length === 0) return { code: "empty-token" };
  if (/\s/.test(token)) return { code: "whitespace-in-token", token };
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
  const removing = new Set(change.remove);
  const segments = splitClassValue(raw);

  const kept: Segment[] = [];
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;
    if (segment.kind !== "token" || !removing.has(decodeEntities(segment.raw))) {
      kept.push(segment);
      continue;
    }
    // Drop one neighbouring gap with the token so the survivors keep single
    // separators. Taking the preceding gap keeps a leading token's indentation
    // attached to whatever now sits first.
    if (kept.length > 0 && kept[kept.length - 1]!.kind === "gap") kept.pop();
    else if (segments[i + 1]?.kind === "gap") i++;
  }

  const present = new Set(kept.filter((s) => s.kind === "token").map((s) => decodeEntities(s.raw)));
  const separator = trailingSeparator(segments);
  const result: Segment[] = [...kept];

  for (const token of change.add) {
    if (present.has(token)) continue;
    present.add(token);
    const encoded = escapeAttributeValue(token, quote);
    const last = result[result.length - 1];
    if (result.some((s) => s.kind === "token") && last?.kind !== "gap") {
      result.push({ kind: "gap", raw: separator });
    }
    result.push({ kind: "token", raw: encoded });
  }

  return result.map((s) => s.raw).join("");
}

/**
 * The separator to use when appending: whichever gap already sat between two
 * tokens, so a value broken across lines gains its new token on a new line.
 */
function trailingSeparator(segments: Segment[]): string {
  for (let i = segments.length - 1; i > 0; i--) {
    const segment = segments[i]!;
    if (
      segment.kind === "gap" &&
      segments[i - 1]?.kind === "token" &&
      segments[i + 1]?.kind === "token"
    ) {
      return segment.raw;
    }
  }
  return " ";
}
