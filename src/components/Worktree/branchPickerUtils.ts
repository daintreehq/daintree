import Fuse, { type IFuseOptions } from "fuse.js";
import type { BranchInfo } from "@/types/electron";
import type { WorktreeSnapshot } from "@shared/types";

export type BranchWorktreeRef = Pick<WorktreeSnapshot, "id" | "name">;

export interface BranchOption {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
  remoteName: string | null;
  labelText: string;
  /**
   * Lower-cased full label — a real Fuse key, not decoration. Keying it means
   * the `(current)`/`(remote)` suffixes the row shows as badges are still
   * reachable by typing them, which they were not while this field existed but
   * nothing searched it.
   */
  searchText: string;
  /** ISO-8601 tip committer date, or null when git gave us none. */
  committerDate: string | null;
}

/**
 * Fuse-native inclusive `[start, end]` tuples, so match ranges feed
 * `HighlightedText` without a conversion hop.
 */
export type BranchMatchRange = readonly [number, number];

export interface BranchSearchResult extends BranchOption {
  score: number;
  matchRanges: readonly BranchMatchRange[];
  isRecent: boolean;
  recentRank: number;
  inUseWorktree: BranchWorktreeRef | null;
}

export type BranchPickerRow =
  { kind: "section"; label: string } | ({ kind: "option" } & BranchSearchResult);

export interface FilterBranchesOptions {
  query: string;
  recentBranchNames: readonly string[];
  worktreeByBranch: ReadonlyMap<string, BranchWorktreeRef>;
  emptyQueryLimit?: number;
}

export function formatBranchLabel(branch: BranchInfo): string {
  const parts = [branch.name];
  if (branch.current) parts.push("(current)");
  if (branch.remote) parts.push("(remote)");
  return parts.join(" ");
}

export function toBranchOption(branch: BranchInfo): BranchOption {
  const labelText = formatBranchLabel(branch);
  return {
    name: branch.name,
    isCurrent: !!branch.current,
    isRemote: !!branch.remote,
    remoteName: branch.remote || null,
    labelText,
    searchText: labelText.toLowerCase(),
    committerDate: branch.committerDate ?? null,
  };
}

/**
 * `useExtendedSearch` gives space-separated tokens implicit AND semantics, which
 * is the whole reason `feat terr` can reach `feature/voxel-terrain`: without it
 * Fuse compares the query — spaces included — as one Bitap pattern.
 *
 * `minMatchCharLength` stays at 2 because it is a hard pre-filter, not a scoring
 * input: dropping it to 1 hands single characters to the typo-tolerant scorer.
 * Sub-2-character queries take `matchBranchesLiterally` instead (see
 * `SHORT_TOKEN_LENGTH`). `ignoreLocation` makes `distance` inert, so it is
 * deliberately absent rather than set.
 */
const BRANCH_FUSE_OPTIONS: IFuseOptions<BranchOption> = {
  keys: [
    { name: "name", weight: 0.8 },
    { name: "searchText", weight: 0.2 },
  ],
  threshold: 0.3,
  ignoreLocation: true,
  minMatchCharLength: 2,
  includeScore: true,
  includeMatches: true,
  useExtendedSearch: true,
};

const RESULT_LIMIT = 200;
const SHORT_TOKEN_LENGTH = 2;

/**
 * Extended search reads these as operators (`=` exact, `!` inverse, `^`/`$`
 * anchors, `'` include, `|` OR). Branch names may legitimately contain `!`, `$`,
 * `'` and `|`, so a query carrying any of them routes to the literal matcher —
 * typing `!hotfix` should find `!hotfix/urgent`, never invert the search.
 */
const EXTENDED_SEARCH_OPERATORS = /[=!'^$|"]/;

function tokenize(query: string): string[] {
  return query.split(/\s+/).filter(Boolean);
}

/** True when Fuse's extended parser would mangle this query's intent. */
function needsLiteralMatch(tokens: readonly string[]): boolean {
  return tokens.some(
    (token) => token.length < SHORT_TOKEN_LENGTH || EXTENDED_SEARCH_OPERATORS.test(token)
  );
}

const fuseCache = new WeakMap<readonly BranchOption[], Fuse<BranchOption>>();

function getFuse(branches: readonly BranchOption[]): Fuse<BranchOption> {
  let fuse = fuseCache.get(branches);
  if (!fuse) {
    fuse = new Fuse(branches as BranchOption[], BRANCH_FUSE_OPTIONS);
    fuseCache.set(branches, fuse);
  }
  return fuse;
}

function toBranchSearchResult(
  option: BranchOption,
  overrides: Partial<BranchSearchResult>
): BranchSearchResult {
  return {
    ...option,
    score: 0,
    matchRanges: [],
    isRecent: false,
    recentRank: 0,
    inUseWorktree: null,
    ...overrides,
  };
}

export function buildBranchRows(
  branches: readonly BranchOption[],
  options: FilterBranchesOptions
): BranchPickerRow[] {
  const { query, recentBranchNames, worktreeByBranch, emptyQueryLimit = 500 } = options;
  const trimmedQuery = query.trim();

  const recentSet = new Set(recentBranchNames);
  const recentRankMap = new Map<string, number>();
  recentBranchNames.forEach((name, i) => recentRankMap.set(name, i + 1));

  if (!trimmedQuery) {
    return buildEmptyQueryRows(
      branches,
      recentSet,
      recentRankMap,
      worktreeByBranch,
      emptyQueryLimit
    );
  }

  return buildFuzzyQueryRows(branches, trimmedQuery, recentSet, recentRankMap, worktreeByBranch);
}

function buildEmptyQueryRows(
  branches: readonly BranchOption[],
  recentSet: Set<string>,
  recentRankMap: Map<string, number>,
  worktreeByBranch: ReadonlyMap<string, BranchWorktreeRef>,
  limit: number
): BranchPickerRow[] {
  const rows: BranchPickerRow[] = [];
  if (limit <= 0) return rows;

  const recentBranches: BranchSearchResult[] = [];
  const otherBranches: BranchSearchResult[] = [];

  for (const branch of branches) {
    const result = toBranchSearchResult(branch, {
      isRecent: recentSet.has(branch.name),
      recentRank: recentRankMap.get(branch.name) ?? 0,
      inUseWorktree: worktreeByBranch.get(branch.name) ?? null,
    });

    if (result.isRecent) {
      recentBranches.push(result);
    } else {
      otherBranches.push(result);
    }
  }

  recentBranches.sort((a, b) => a.recentRank - b.recentRank);

  // The cap counts Recent rows too. Letting the Recent band overrun it (as the
  // previous `limit - recentBranches.length` did, once that went negative)
  // would put more rows on screen than the footnote claims.
  const cappedRecent = recentBranches.slice(0, limit);
  if (cappedRecent.length > 0) {
    rows.push({ kind: "section", label: "Recent" });
    for (const branch of cappedRecent) {
      rows.push({ kind: "option", ...branch });
    }
  }

  let remaining = limit - cappedRecent.length;
  for (const branch of otherBranches) {
    if (remaining <= 0) break;
    rows.push({ kind: "option", ...branch });
    remaining--;
  }

  return rows;
}

function nameMatchRanges(name: string, tokens: readonly string[]): BranchMatchRange[] {
  const lowerName = name.toLowerCase();
  const ranges: BranchMatchRange[] = [];
  for (const token of tokens) {
    const at = lowerName.indexOf(token);
    if (at >= 0) ranges.push([at, at + token.length - 1]);
  }
  return ranges;
}

/**
 * Deterministic AND-of-substrings for queries Fuse's extended parser can't be
 * trusted with. Every token must appear in the full label, so a query stays
 * literal — `foo|bar` looks for that string, not "foo OR bar". Name-prefix
 * matches lead, then name-substring, then label-only (a hit that landed on the
 * `(current)`/`(remote)` suffix); source order breaks ties.
 */
function matchBranchesLiterally(
  branches: readonly BranchOption[],
  tokens: readonly string[]
): { option: BranchOption; matchRanges: BranchMatchRange[] }[] {
  const ranked: { option: BranchOption; rank: number; matchRanges: BranchMatchRange[] }[] = [];

  for (const option of branches) {
    if (!tokens.every((token) => option.searchText.includes(token))) continue;

    const lowerName = option.name.toLowerCase();
    const inName = tokens.every((token) => lowerName.includes(token));
    const rank = !inName ? 2 : lowerName.startsWith(tokens[0]!) ? 0 : 1;

    ranked.push({ option, rank, matchRanges: nameMatchRanges(option.name, tokens) });
  }

  // Index-stable: `sort` is stable in ES2019+, so equal ranks keep source order.
  ranked.sort((a, b) => a.rank - b.rank);
  return ranked.slice(0, RESULT_LIMIT).map(({ option, matchRanges }) => ({ option, matchRanges }));
}

function buildFuzzyQueryRows(
  branches: readonly BranchOption[],
  query: string,
  recentSet: Set<string>,
  recentRankMap: Map<string, number>,
  worktreeByBranch: ReadonlyMap<string, BranchWorktreeRef>
): BranchPickerRow[] {
  const tokens = tokenize(query);
  const enrich = (
    option: BranchOption,
    score: number,
    matchRanges: readonly BranchMatchRange[]
  ): BranchPickerRow => ({
    kind: "option" as const,
    ...toBranchSearchResult(option, {
      score,
      matchRanges,
      isRecent: recentSet.has(option.name),
      recentRank: recentRankMap.get(option.name) ?? 0,
      inUseWorktree: worktreeByBranch.get(option.name) ?? null,
    }),
  });

  if (needsLiteralMatch(tokens)) {
    return matchBranchesLiterally(
      branches,
      tokens.map((t) => t.toLowerCase())
    ).map(({ option, matchRanges }) => enrich(option, 0, matchRanges));
  }

  const results = getFuse(branches).search(query, { limit: RESULT_LIMIT });

  return results.map((result) => {
    // Only `name` ranges are rendered: a hit that landed in `searchText`'s
    // trailing `(current)`/`(remote)` has no counterpart in the row, which now
    // draws those as separate badges instead of one baked string.
    const match = result.matches?.find((m) => m.key === "name");
    return enrich(result.item, result.score ?? 0, match?.indices ?? []);
  });
}
