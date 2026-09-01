export const MULTI_FETCH_CAP = 20;

export type NumberQuery =
  | { kind: "single"; number: number }
  | { kind: "multi"; numbers: number[] }
  | { kind: "range"; from: number; to: number; truncated: boolean }
  | { kind: "open-ended"; from: number };

const OPEN_ENDED_RE = /^#?(\d+)\+$/;
const RANGE_RE = /^#?(\d+)\.\.(\d+)$/;
// Two or more numbers joined by a comma, whitespace, or an "and" that may
// follow either. A trailing comma is tolerated because that is what pasting a
// list leaves behind, and bare whitespace because that is what falls out of a
// terminal. Anchored end to end: one stray word or symbol and the whole thing
// stays a text search.
//
// Case-sensitive on purpose. GitHub search reads uppercase `AND`/`OR` as
// boolean operators, so "123 AND 456" is a real full-text query and must not
// be hijacked into a lookup.
const NUMBER_LIST_RE = /^#?\d+(?:(?:\s*,\s*|\s+)(?:and\s+)?#?\d+)+\s*,?$/;
const SINGLE_RE = /^#?(\d+)\s*,?$/;

export function parseNumberQuery(query: string): NumberQuery | null {
  const trimmed = query.trim();
  if (!trimmed) return null;

  // Open-ended: 130+ or #130+
  const openMatch = trimmed.match(OPEN_ENDED_RE);
  if (openMatch) {
    const from = parseInt(openMatch[1]!, 10);
    if (from <= 0 || !Number.isSafeInteger(from)) return null;
    return { kind: "open-ended", from };
  }

  // Range: 123..127 or #123..127
  const rangeMatch = trimmed.match(RANGE_RE);
  if (rangeMatch) {
    const from = parseInt(rangeMatch[1]!, 10);
    const to = parseInt(rangeMatch[2]!, 10);
    if (from <= 0 || to <= 0 || !Number.isSafeInteger(from) || !Number.isSafeInteger(to))
      return null;
    if (from > to) return null;
    const count = to - from + 1;
    const truncated = count > MULTI_FETCH_CAP;
    return {
      kind: "range",
      from,
      to: truncated ? from + MULTI_FETCH_CAP - 1 : to,
      truncated,
    };
  }

  // Number list: 123, 124 / 123 124 / #123, 124, and 125
  if (NUMBER_LIST_RE.test(trimmed)) {
    const seen = new Set<number>();
    const numbers: number[] = [];
    // The shape is already validated, so every run of digits is one of the
    // requested numbers — separators and "and" contribute none.
    for (const token of trimmed.match(/\d+/g) ?? []) {
      const num = parseInt(token, 10);
      if (num <= 0 || !Number.isSafeInteger(num)) return null;
      if (!seen.has(num)) {
        seen.add(num);
        numbers.push(num);
      }
    }
    if (numbers.length === 1) return { kind: "single", number: numbers[0]! };
    return { kind: "multi", numbers };
  }

  // Single: 123 or #123
  const singleMatch = trimmed.match(SINGLE_RE);
  if (singleMatch) {
    const num = parseInt(singleMatch[1]!, 10);
    if (num <= 0 || !Number.isSafeInteger(num)) return null;
    return { kind: "single", number: num };
  }

  return null;
}

/**
 * True when a query {@link parseNumberQuery} rejected still reads as an
 * attempt at a number list: two or more numbers with nothing between them but
 * separators and the words "and"/"or".
 *
 * Deliberately narrow. A text search that merely contains digits — "2024
 * roadmap", "fix 123 crash", a version like "1.2.3", a date like "2024-01-15"
 * — is working exactly as intended, and telling someone their working search
 * is a search is noise. Only inputs that were plainly meant as a lookup earn
 * the hint.
 */
export function looksLikeNumberList(query: string): boolean {
  const trimmed = query.trim();
  if (!trimmed) return false;
  if (parseNumberQuery(trimmed) !== null) return false;
  // Connectors are the only words allowed through; anything else is prose.
  // Lowercase only, for the same reason the grammar is: uppercase `AND`/`OR`
  // is GitHub boolean search syntax and belongs to full-text search.
  const withoutConnectors = trimmed.replace(/\b(?:and|or)\b/g, " ");
  if (/[^\d#,;&\s]/.test(withoutConnectors)) return false;
  return (trimmed.match(/\d+/g) ?? []).length >= 2;
}
