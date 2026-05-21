import type { FuseResultMatch } from "@/hooks/useSearchablePalette";

interface HighlightedTextProps {
  text: string;
  indices: readonly [number, number][] | undefined;
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
      <span key={i} className="text-search-highlight-text">
        {text.substring(start, end + 1)}
      </span>
    );
    lastIndex = end + 1;
  });
  if (lastIndex < text.length) parts.push(text.substring(lastIndex));
  return <>{parts}</>;
}

export function findMatchIndices(
  matches: readonly FuseResultMatch[] | undefined,
  key: string
): readonly [number, number][] | undefined {
  return matches?.find((m) => m.key === key)?.indices;
}
