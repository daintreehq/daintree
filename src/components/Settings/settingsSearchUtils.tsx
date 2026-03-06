import type { SettingsTab } from "./SettingsDialog";
import type { SettingsSearchEntry } from "./settingsSearchIndex";

export type SettingsSearchResult = SettingsSearchEntry;

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function filterSettings(
  index: SettingsSearchEntry[],
  query: string
): SettingsSearchResult[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];

  return index.filter((entry) => {
    const haystack = [
      entry.title,
      entry.description,
      entry.section,
      entry.tabLabel,
      ...(entry.keywords ?? []),
    ]
      .join(" ")
      .toLowerCase();

    return haystack.includes(normalized);
  });
}

export function countMatchesPerTab(
  results: SettingsSearchResult[]
): Partial<Record<SettingsTab, number>> {
  const counts: Partial<Record<SettingsTab, number>> = {};
  for (const r of results) {
    counts[r.tab] = (counts[r.tab] ?? 0) + 1;
  }
  return counts;
}

interface HighlightTextProps {
  text: string;
  query: string;
}

export function HighlightText({ text, query }: HighlightTextProps) {
  const normalized = query.trim();
  if (!normalized) return <span>{text}</span>;

  try {
    const parts = text.split(new RegExp(`(${escapeRegex(normalized)})`, "gi"));
    return (
      <span>
        {parts.map((part, i) =>
          part.toLowerCase() === normalized.toLowerCase() ? (
            <mark key={i} className="bg-canopy-accent/25 text-inherit rounded-sm not-italic">
              {part}
            </mark>
          ) : (
            <span key={i}>{part}</span>
          )
        )}
      </span>
    );
  } catch {
    return <span>{text}</span>;
  }
}
