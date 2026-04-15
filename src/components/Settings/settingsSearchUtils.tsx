import Fuse, { type Expression, type IFuseOptions } from "fuse.js";
import type { SettingsTab, SettingsScope } from "./SettingsDialog";
import type { SettingsSearchEntry } from "./settingsSearchIndex";

export type SettingsSearchResult = SettingsSearchEntry;

const MODIFIED_TOKEN_RE = /(?:^|\s)@mod(?:ified)?(?=\s|$)/i;

const FUSE_OPTIONS: IFuseOptions<SettingsSearchEntry> = {
  keys: [
    { name: "title", weight: 0.7 },
    { name: "keywords", weight: 0.5 },
    { name: "tabLabel", weight: 0.3 },
    { name: "description", weight: 0.2 },
    { name: "section", weight: 0.15 },
    { name: "subtabLabel", weight: 0.15 },
  ],
  threshold: 0.3,
  location: 0,
  distance: 100,
  minMatchCharLength: 2,
  includeScore: true,
  ignoreLocation: false,
  ignoreFieldNorm: false,
  useExtendedSearch: true,
};

const fuseCache = new WeakMap<readonly SettingsSearchEntry[], Fuse<SettingsSearchEntry>>();

function getFuse(index: readonly SettingsSearchEntry[]): Fuse<SettingsSearchEntry> {
  let fuse = fuseCache.get(index);
  if (!fuse) {
    fuse = new Fuse(index as SettingsSearchEntry[], FUSE_OPTIONS);
    fuseCache.set(index, fuse);
  }
  return fuse;
}

export interface ParsedQuery {
  cleanQuery: string;
  tokens: string[];
  filterModified: boolean;
}

export function parseQuery(raw: string): ParsedQuery {
  const filterModified = MODIFIED_TOKEN_RE.test(raw);
  // Use a global version to strip all occurrences
  let cleanQuery = raw;
  if (filterModified) {
    cleanQuery = raw.replace(/(?:^|\s)@mod(?:ified)?(?=\s|$)/gi, " ").trim();
  }
  const tokens = cleanQuery.toLowerCase().split(/\s+/).filter(Boolean);
  return { cleanQuery, tokens, filterModified };
}

export interface FilterSettingsOptions {
  modifiedTabs?: ReadonlySet<SettingsTab>;
  scope?: SettingsScope;
}

export function filterSettings(
  index: readonly SettingsSearchEntry[],
  query: string,
  options?: FilterSettingsOptions
): SettingsSearchResult[] {
  const { cleanQuery, tokens, filterModified } = parseQuery(query);

  if (!cleanQuery && !filterModified) return [];

  const scopeFilter = options?.scope;
  const scopedIndex = scopeFilter ? index.filter((entry) => entry.scope === scopeFilter) : index;

  // @modified only — return all entries in modified tabs
  if (!cleanQuery && filterModified) {
    const modifiedTabs = options?.modifiedTabs;
    if (!modifiedTabs || modifiedTabs.size === 0) return [];
    return scopedIndex.filter((entry) => modifiedTabs.has(entry.tab));
  }

  const fuse = getFuse(scopedIndex);

  // Always use structured $and query; escape operator prefixes so user input
  // like "!font" isn't interpreted as a Fuse NOT operator
  const structured = {
    $and: tokens.map((token) => {
      // Prefix with ' (include operator) to force literal fuzzy matching
      // and prevent =, !, ^, $ from being treated as Fuse operators
      const safeToken = /^[=!'^$]/.test(token) ? `'${token}` : token;
      return {
        $or: [
          { title: safeToken },
          { keywords: safeToken },
          { tabLabel: safeToken },
          { description: safeToken },
          { section: safeToken },
          { subtabLabel: safeToken },
        ],
      };
    }),
  };
  const fuseResults = fuse.search(structured as unknown as Expression);

  // Apply post-scoring: preserve existing ranking behavior
  const normalized = cleanQuery.toLowerCase();
  const scored = fuseResults.map((result) => {
    const entry = result.item;
    const fuseScore = result.score ?? 0;
    // Convert Fuse score (0=best, 1=worst) to our convention (higher=better)
    let score = (1 - fuseScore) * 10;

    const titleLower = entry.title.toLowerCase();
    const tabLabelLower = entry.tabLabel.toLowerCase();
    const keywordsLower = (entry.keywords ?? []).join(" ").toLowerCase();

    for (const token of tokens) {
      if (titleLower.includes(token)) score += 3;
      if (keywordsLower.includes(token)) score += 1;
    }

    if (tabLabelLower === normalized) {
      score += 5;
      if (entry.id.startsWith("tab-nav-")) {
        score += 2;
      }
    } else if (tokens.length > 1 && entry.id.startsWith("tab-nav-")) {
      score -= 3;
    }

    return { entry, score };
  });

  scored.sort((a, b) => b.score - a.score);

  let results = scored.map((r) => r.entry);

  // Apply @modified filter if active
  if (filterModified) {
    const modifiedTabs = options?.modifiedTabs;
    if (!modifiedTabs || modifiedTabs.size === 0) return [];
    results = results.filter((entry) => modifiedTabs.has(entry.tab));
  }

  return results;
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

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface HighlightTextProps {
  text: string;
  query: string;
}

export function HighlightText({ text, query }: HighlightTextProps) {
  const { cleanQuery, tokens } = parseQuery(query);
  if (!cleanQuery) return <span>{text}</span>;

  try {
    const pattern = tokens.map(escapeRegex).join("|");
    const parts = text.split(new RegExp(`(${pattern})`, "gi"));
    const lowerTokens = tokens.map((t) => t.toLowerCase());
    return (
      <span>
        {parts.map((part, i) =>
          lowerTokens.some((t) => part.toLowerCase() === t) ? (
            <mark key={i} className="bg-daintree-accent/25 text-inherit rounded-sm not-italic">
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
