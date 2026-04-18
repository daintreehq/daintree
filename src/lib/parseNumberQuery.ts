export const MULTI_FETCH_CAP = 20;

export type NumberQuery =
  | { kind: "single"; number: number }
  | { kind: "multi"; numbers: number[] }
  | { kind: "range"; from: number; to: number; truncated: boolean }
  | { kind: "open-ended"; from: number };

const OPEN_ENDED_RE = /^#?(\d+)\+$/;
const RANGE_RE = /^#?(\d+)\.\.(\d+)$/;
const COMMA_RE = /^#?\d+(\s*,\s*#?\d+)+$/;
const SINGLE_RE = /^#?(\d+)$/;

export function parseNumberQuery(query: string): NumberQuery | null {
  const trimmed = query.trim();
  if (!trimmed) return null;

  // Open-ended: 130+ or #130+
  const openMatch = trimmed.match(OPEN_ENDED_RE);
  if (openMatch) {
    const from = parseInt(openMatch[1]!, 10);
    if (from <= 0 || !Number.isFinite(from)) return null;
    return { kind: "open-ended", from };
  }

  // Range: 123..127 or #123..127
  const rangeMatch = trimmed.match(RANGE_RE);
  if (rangeMatch) {
    const from = parseInt(rangeMatch[1]!, 10);
    const to = parseInt(rangeMatch[2]!, 10);
    if (from <= 0 || to <= 0 || !Number.isFinite(from) || !Number.isFinite(to)) return null;
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

  // Comma list: 123, 124 or #123, #124
  if (COMMA_RE.test(trimmed)) {
    const parts = trimmed.split(/\s*,\s*/);
    const seen = new Set<number>();
    const numbers: number[] = [];
    for (const part of parts) {
      const num = parseInt(part.replace(/^#/, ""), 10);
      if (num <= 0 || !Number.isFinite(num)) return null;
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
    if (num <= 0 || !Number.isFinite(num)) return null;
    return { kind: "single", number: num };
  }

  return null;
}
