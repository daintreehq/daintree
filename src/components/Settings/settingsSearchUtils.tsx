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
    cleanQuery = raw.replace(/(?:^|\s)@mod(?:ified)?(?=\s|$)/gi, " ");
  }
  cleanQuery = cleanQuery.trim();
  const tokens = cleanQuery.toLowerCase().split(/\s+/).filter(Boolean);
  return { cleanQuery, tokens, filterModified };
}

export interface FilterSettingsOptions {
  modifiedTabs?: ReadonlySet<SettingsTab>;
  /**
   * The user's currently-active scope. When a text query is present this
   * acts as a *ranking boost* — same-scope entries earn `SAME_SCOPE_BOOST`
   * to win close ties but cross-scope results still appear, so searching
   * "branch prefix" from the global scope still surfaces the project-scope
   * entry. For `@modified`-only queries this remains a hard filter, since
   * the empty-state copy is scope-specific.
   */
  scope?: SettingsScope;
  /**
   * When false, strips project-scope entries from text-query results — they
   * would navigate to a tab that shows an empty project form when no
   * project is open. Omitted = no guard (preserves call-sites that don't
   * know project state).
   */
  hasProject?: boolean;
}

// Boost given to entries whose scope matches the user's active scope when a
// text query is present. Sized to keep same-scope content (e.g.
// notifications-sound when on global) above cross-scope tab navigation
// entries that match the same query — absorbs small data quirks like
// titles using the singular ("Notification sound") while the user types
// the plural ("notifications").
const SAME_SCOPE_BOOST = 5;

export function filterSettings(
  index: readonly SettingsSearchEntry[],
  query: string,
  options?: FilterSettingsOptions
): SettingsSearchResult[] {
  const { cleanQuery, tokens, filterModified } = parseQuery(query);

  if (!cleanQuery && !filterModified) return [];

  const activeScope = options?.scope;

  // @modified only — return all entries in modified tabs, still scoped to
  // the active scope so the scope-specific empty state stays coherent.
  if (!cleanQuery && filterModified) {
    const modifiedTabs = options?.modifiedTabs;
    if (!modifiedTabs || modifiedTabs.size === 0) return [];
    const scopedIndex = activeScope ? index.filter((entry) => entry.scope === activeScope) : index;
    return scopedIndex.filter((entry) => modifiedTabs.has(entry.tab));
  }

  // Key the Fuse cache on the stable index reference. Previously the cache
  // was keyed on the .filter()-derived scopedIndex which returns a new array
  // on every call, so the WeakMap never hit and a fresh Fuse was built for
  // each query.
  const fuse = getFuse(index);

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
        // Only stack the extra tab-nav bonus when the entry is in the
        // user's active scope. Cross-scope tab-nav rows would otherwise
        // bury same-scope content entries that match the same label
        // (e.g. tab-nav-project:notifications burying notifications-sound
        // when the user searches "notifications" from global scope).
        const isSameScope = !activeScope || entry.scope === activeScope;
        if (isSameScope) score += 2;
      }
    } else if (tokens.length > 1 && entry.id.startsWith("tab-nav-")) {
      score -= 3;
    }

    if (activeScope && entry.scope === activeScope) {
      score += SAME_SCOPE_BOOST;
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

  // Hide project-scope entries when no project is open — they'd lead to an
  // empty project form. Same guard the nav sidebar already applies.
  if (options?.hasProject === false) {
    results = results.filter((entry) => entry.scope !== "project");
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
            <span key={i} className="text-search-highlight-text">
              {part}
            </span>
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
