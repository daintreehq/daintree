import Fuse, { type IFuseOptions } from "fuse.js";
import type { BranchInfo } from "@/types/electron";
import type { WorktreeState } from "@shared/types";

export interface BranchOption {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
  remoteName: string | null;
  labelText: string;
  searchText: string;
}

export interface BranchMatchRange {
  start: number;
  end: number;
}

export interface BranchSearchResult extends BranchOption {
  score: number;
  matchRanges: BranchMatchRange[];
  isRecent: boolean;
  recentRank: number;
  inUseWorktree: WorktreeState | null;
}

export type BranchPickerRow =
  | { kind: "section"; label: string }
  | ({ kind: "option" } & BranchSearchResult);

export interface FilterBranchesOptions {
  query: string;
  recentBranchNames: string[];
  worktreeByBranch: Map<string, WorktreeState>;
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
  };
}

const BRANCH_FUSE_OPTIONS: IFuseOptions<BranchOption> = {
  keys: [{ name: "name", weight: 1.0 }],
  threshold: 0.3,
  ignoreLocation: true,
  minMatchCharLength: 2,
  includeScore: true,
  includeMatches: true,
};

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
    return buildEmptyQueryRows(branches, recentSet, recentRankMap, worktreeByBranch, emptyQueryLimit);
  }

  return buildFuzzyQueryRows(branches, trimmedQuery, recentSet, recentRankMap, worktreeByBranch);
}

function buildEmptyQueryRows(
  branches: readonly BranchOption[],
  recentSet: Set<string>,
  recentRankMap: Map<string, number>,
  worktreeByBranch: Map<string, WorktreeState>,
  limit: number
): BranchPickerRow[] {
  const rows: BranchPickerRow[] = [];

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

  if (recentBranches.length > 0) {
    rows.push({ kind: "section", label: "Recent" });
    for (const branch of recentBranches) {
      rows.push({ kind: "option", ...branch });
    }
  }

  let remaining = limit - recentBranches.length;
  if (remaining > 0) {
    for (const branch of otherBranches) {
      if (remaining <= 0) break;
      rows.push({ kind: "option", ...branch });
      remaining--;
    }
  }

  return rows;
}

function buildFuzzyQueryRows(
  branches: readonly BranchOption[],
  query: string,
  recentSet: Set<string>,
  recentRankMap: Map<string, number>,
  worktreeByBranch: Map<string, WorktreeState>
): BranchPickerRow[] {
  const fuse = getFuse(branches);
  const results = fuse.search(query);

  return results.map((result) => {
    const matchRanges: BranchMatchRange[] = [];
    const match = result.matches?.find((m) => m.key === "name");
    if (match) {
      for (const [start, end] of match.indices) {
        matchRanges.push({ start, end });
      }
    }

    return {
      kind: "option" as const,
      ...toBranchSearchResult(result.item, {
        score: result.score ?? 0,
        matchRanges,
        isRecent: recentSet.has(result.item.name),
        recentRank: recentRankMap.get(result.item.name) ?? 0,
        inUseWorktree: worktreeByBranch.get(result.item.name) ?? null,
      }),
    };
  });
}

/** @deprecated Use buildBranchRows instead */
export function filterBranches(
  branches: BranchOption[],
  query: string,
  limit: number = 200
): BranchOption[] {
  if (limit <= 0) return [];

  const trimmedQuery = query.trim();
  if (!trimmedQuery) return branches.slice(0, limit);

  const lowerQuery = trimmedQuery.toLowerCase();
  const filtered: BranchOption[] = [];

  for (const branch of branches) {
    if (branch.searchText.includes(lowerQuery)) {
      filtered.push(branch);
      if (filtered.length >= limit) break;
    }
  }

  return filtered;
}
