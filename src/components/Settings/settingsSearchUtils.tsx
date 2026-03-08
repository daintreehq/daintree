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

  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];

  const scored = index
    .map((entry) => {
      const haystack = [
        entry.title,
        entry.description,
        entry.section,
        entry.tabLabel,
        ...(entry.keywords ?? []),
      ]
        .join(" ")
        .toLowerCase();

      const allMatch = tokens.every((token) => haystack.includes(token));
      if (!allMatch) return null;

      let score = 0;
      const titleLower = entry.title.toLowerCase();
      const keywordsLower = (entry.keywords ?? []).join(" ").toLowerCase();
      for (const token of tokens) {
        if (titleLower.includes(token)) score += 3;
        if (keywordsLower.includes(token)) score += 1;
      }

      return { entry, score };
    })
    .filter((r): r is { entry: SettingsSearchEntry; score: number } => r !== null);

  scored.sort((a, b) => b.score - a.score);
  return scored.map((r) => r.entry);
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
    const tokens = normalized.split(/\s+/).filter(Boolean);
    const pattern = tokens.map(escapeRegex).join("|");
    const parts = text.split(new RegExp(`(${pattern})`, "gi"));
    const lowerTokens = tokens.map((t) => t.toLowerCase());
    return (
      <span>
        {parts.map((part, i) =>
          lowerTokens.some((t) => part.toLowerCase() === t) ? (
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
