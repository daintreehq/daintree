import type { FuseResultMatch } from "@/hooks/useSearchablePalette";

interface HighlightedTextProps {
  text: string;
  indices: readonly [number, number][] | undefined;
}

export function HighlightedText({ text, indices }: HighlightedTextProps) {
  if (!indices?.length) return <>{text}</>;
  const sorted = [...indices].sort((a, b) => a[0] - b[0]);
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  sorted.forEach(([start, end], i) => {
    if (start > lastIndex) parts.push(text.substring(lastIndex, start));
    parts.push(
      <span key={i} className="text-search-highlight-text font-semibold">
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
