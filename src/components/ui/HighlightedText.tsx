import type { FuseResultMatch } from "@/hooks/useSearchablePalette";

interface HighlightedTextProps {
  text: string;
  /**
   * Readonly on both axes so fuse's own `RangeTuple` (a readonly tuple) can be
   * handed over without a copy. The merge below only ever pushes fresh arrays,
   * so nothing here is mutated in place.
   */
  indices: readonly (readonly [number, number])[] | undefined;
}

export function HighlightedText({ text, indices }: HighlightedTextProps) {
  if (!indices?.length) return <>{text}</>;
  // Merge adjacent and overlapping ranges so a contiguous match renders as a
  // single span (sub-pixel gaps otherwise appear between adjacent spans). Fuse
  // can emit unsorted/overlapping indices when a query is split across
  // BitapSearch chunks; using `prev.end + 1` as the merge threshold unifies
  // adjacency (touching ranges) and overlap.
  const sorted = [...indices]
    .filter(([s, e]) => s >= 0 && s <= e && e < text.length)
    .sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [s, e] of sorted) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1] + 1) {
      last[1] = Math.max(last[1], e);
    } else {
      merged.push([s, e]);
    }
  }
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  merged.forEach(([start, end], i) => {
    if (start > lastIndex) parts.push(text.substring(lastIndex, start));
    parts.push(
      // A neutral band, not accent. A query can match many substrings across
      // many rows, so painting each one in the accent colour spends the accent
      // budget on membership — the one thing the restraint rule names outright
      // — and leaves the focused field competing with its own results.
      //
      // A background rather than weight: bolding the match was removed here
      // deliberately because the row reflows as the user types. A band changes
      // no metrics, and it is the same idiom document search already uses in
      // the terminal, diff and code viewers, which keep the
      // `search-highlight-*` tokens for exactly that job.
      <span key={i} className="bg-overlay-medium text-text-primary">
        {text.substring(start, end + 1)}
      </span>
    );
    lastIndex = end + 1;
  });
  if (lastIndex < text.length) parts.push(text.substring(lastIndex));
  return <>{parts}</>;
}

/**
 * The range a plain case-insensitive substring filter matched, for lists that
 * filter with `includes` rather than fuse. One range, the first occurrence: it
 * marks exactly what the filter tested, where a whitespace-tokenised highlight
 * would mark words the whole-query filter never matched.
 */
export function substringMatchIndices(
  text: string,
  query: string
): readonly [number, number][] | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  const lower = text.toLowerCase();
  if (lower.length === text.length) {
    const start = lower.indexOf(q);
    return start < 0 ? undefined : [[start, start + q.length - 1]];
  }
  // Some characters lowercase to more code units ("İ" → "i̇"), so an offset in
  // the lowered string is not an offset in the text. Lower one character at a
  // time and remember which original character each lowered unit came from.
  let lowered = "";
  let offset = 0;
  const from: [number, number][] = [];
  for (const ch of text) {
    const unit: [number, number] = [offset, offset + ch.length - 1];
    const l = ch.toLowerCase();
    lowered += l;
    for (let i = 0; i < l.length; i++) from.push(unit);
    offset += ch.length;
  }
  const at = lowered.indexOf(q);
  const first = from[at];
  const last = from[at + q.length - 1];
  return at < 0 || !first || !last ? undefined : [[first[0], last[1]]];
}

export function findMatchIndices(
  matches: readonly FuseResultMatch[] | undefined,
  key: string
): readonly [number, number][] | undefined {
  return matches?.find((m) => m.key === key)?.indices;
}
