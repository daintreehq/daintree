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
export const BRANCH_FUSE_OPTIONS: IFuseOptions<BranchOption> = {
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

interface BranchSearchIndex {
  fuse: Fuse<BranchOption>;
  /** Every searched field of each branch, folded the way Fuse folds text before matching. */
  foldedFields: readonly (readonly string[])[];
}

const searchIndexCache = new WeakMap<readonly BranchOption[], BranchSearchIndex>();

function getSearchIndex(branches: readonly BranchOption[]): BranchSearchIndex {
  let index = searchIndexCache.get(branches);
  if (!index) {
    index = {
      fuse: new Fuse(branches, BRANCH_FUSE_OPTIONS),
      foldedFields: branches.map((b) => [b.name.toLowerCase(), b.searchText.toLowerCase()]),
    };
    searchIndexCache.set(branches, index);
  }
  return index;
}

/** Bitap's hard pattern limit; longer tokens are searched in chunks, which the filter can't bound. */
const BITAP_MAX_PATTERN_LENGTH = 32;

/**
 * The most edits Bitap can spend on a token and still score within the
 * threshold. With `ignoreLocation` its per-level score is `errors / length`.
 */
function maxFuzzyErrors(length: number): number {
  const threshold = BRANCH_FUSE_OPTIONS.threshold!;
  let errors = 0;
  while (errors + 1 < length && (errors + 1) / length <= threshold) errors++;
  return errors;
}

interface FuzzyPattern {
  /**
   * `maxErrors + 1` contiguous pieces. A substring within k edits of the token
   * must contain at least one of k + 1 disjoint pieces verbatim, since each edit
   * can break at most one — a cheap rejection before the exact check.
   */
  pieces: string[];
  maxErrors: number;
  /** Bit i set where the token's code unit i is this one. */
  peq: Map<number, number>;
  length: number;
}

function compileFuzzyPattern(token: string): FuzzyPattern {
  const maxErrors = maxFuzzyErrors(token.length);
  const count = maxErrors + 1;
  const pieces: string[] = [];
  for (let i = 0; i < count; i++) {
    pieces.push(
      token.slice(
        Math.floor((i * token.length) / count),
        Math.floor(((i + 1) * token.length) / count)
      )
    );
  }
  const peq = new Map<number, number>();
  for (let i = 0; i < token.length; i++) {
    const code = token.charCodeAt(i);
    peq.set(code, (peq.get(code) ?? 0) | (1 << i));
  }
  return { pieces, maxErrors, peq, length: token.length };
}

/**
 * True when some substring of `text` is within `maxErrors` Levenshtein edits of
 * the token — the condition Bitap's error levels test, so a false here is a
 * branch Fuse would not match. Myers' bit-parallel search, one pass over `text`.
 */
function withinEditDistance(text: string, pattern: FuzzyPattern): boolean {
  const { peq, length, maxErrors } = pattern;
  if (!pattern.pieces.some((piece) => text.includes(piece))) return false;
  const lastBit = 1 << (length - 1);
  let pv = -1;
  let mv = 0;
  let score = length;
  for (let j = 0; j < text.length; j++) {
    const eq = peq.get(text.charCodeAt(j)) ?? 0;
    const xv = eq | mv;
    const xh = (((eq & pv) + pv) ^ pv) | eq;
    let ph = mv | ~(xh | pv);
    let mh = pv & xh;
    if (ph & lastBit) score++;
    else if (mh & lastBit) score--;
    if (score <= maxErrors) return true;
    ph <<= 1;
    mh <<= 1;
    pv = mh | ~(xv | ph);
    mv = ph & xv;
  }
  return false;
}

/**
 * The fuzzy patterns Fuse's extended search derives from a query, folded as it
 * folds them: the whole query lowercased, split on spaces only (a tab stays
 * inside its token), blank tokens dropped, each token lowercased again by its
 * Bitap searcher. Returns null when the query could parse into anything else:
 * an operator; NUL, which Fuse rewrites to `|`; or a line terminator, which its
 * fuzzy matcher's `/^(.*)$/` can't span, so Fuse silently drops that token.
 */
function fuzzyPatterns(query: string): string[] | null {
  if (EXTENDED_SEARCH_OPERATORS.test(query) || /[\0\n\r\u2028\u2029]/.test(query)) return null;
  const tokens = query
    .toLowerCase()
    .trim()
    .split(" ")
    .filter((token) => token && token.trim())
    .map((token) => token.toLowerCase());
  if (tokens.length === 0) return null;
  if (tokens.some((token) => token.length > BITAP_MAX_PATTERN_LENGTH)) return null;
  return tokens;
}

/**
 * Fuse over only the branches that can possibly match, so a keystroke skips the
 * Bitap scan of every branch the query can't reach. Each surviving branch is
 * scored by the same index record, and the records keep their original
 * positions, so scores, match indices and the score-then-position order are
 * exactly what a search over the full list returns.
 */
export function searchBranches(branches: readonly BranchOption[], query: string) {
  const { fuse, foldedFields } = getSearchIndex(branches);
  const patterns = fuzzyPatterns(query);
  if (!patterns) return fuse.search(query);

  const compiled = patterns.map(compileFuzzyPattern);
  const fieldCanMatch = (field: string) =>
    compiled.every((pattern) => withinEditDistance(field, pattern));

  const { keys, records } = fuse.getIndex();
  const candidates = records.filter((record) => foldedFields[record.i]!.some(fieldCanMatch));
  if (candidates.length === records.length) return fuse.search(query);

  const narrowed = new Fuse(
    branches,
    BRANCH_FUSE_OPTIONS,
    Fuse.parseIndex<BranchOption>({ keys, records: candidates })
  );
  return narrowed.search(query);
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

export interface BranchRowsResult {
  rows: BranchPickerRow[];
  /**
   * Candidates that qualified BEFORE the display cap — every branch for an empty
   * query, every match for a search. Compared against the rendered option count,
   * this is what tells the panel it truncated. Without it a search capped at
   * `RESULT_LIMIT` would hide results silently, which one-character queries made
   * reachable for the first time.
   */
  matchedTotal: number;
}

export function buildBranchRows(
  branches: readonly BranchOption[],
  options: FilterBranchesOptions
): BranchRowsResult {
  const { query, recentBranchNames, worktreeByBranch, emptyQueryLimit = 500 } = options;
  const trimmedQuery = query.trim();

  const recentSet = new Set(recentBranchNames);
  const recentRankMap = new Map<string, number>();
  recentBranchNames.forEach((name, i) => recentRankMap.set(name, i + 1));

  if (!trimmedQuery) {
    return {
      rows: buildEmptyQueryRows(
        branches,
        recentSet,
        recentRankMap,
        worktreeByBranch,
        emptyQueryLimit
      ),
      matchedTotal: branches.length,
    };
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
  // Indices are found in the folded string but applied to the original, so they
  // only line up while folding is length-preserving. It isn't universally —
  // `"İ".toLowerCase()` is two code units — and git allows such names, so rather
  // than highlight the wrong characters we highlight none.
  if (lowerName.length !== name.length) return [];

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
): { matches: { option: BranchOption; matchRanges: BranchMatchRange[] }[]; matchedTotal: number } {
  const ranked: { option: BranchOption; rank: number; matchRanges: BranchMatchRange[] }[] = [];

  for (const option of branches) {
    if (!tokens.every((token) => option.searchText.includes(token))) continue;

    const lowerName = option.name.toLowerCase();
    const inName = tokens.every((token) => lowerName.includes(token));
    const rank = !inName ? 2 : lowerName.startsWith(tokens[0]!) ? 0 : 1;

    ranked.push({ option, rank, matchRanges: nameMatchRanges(option.name, tokens) });
  }

  // Sort before slicing so the cap keeps the best-ranked matches, not the first
  // ones encountered. `sort` is stable in ES2019+, so equal ranks keep source order.
  ranked.sort((a, b) => a.rank - b.rank);
  return {
    matches: ranked.slice(0, RESULT_LIMIT).map(({ option, matchRanges }) => ({
      option,
      matchRanges,
    })),
    matchedTotal: ranked.length,
  };
}

function buildFuzzyQueryRows(
  branches: readonly BranchOption[],
  query: string,
  recentSet: Set<string>,
  recentRankMap: Map<string, number>,
  worktreeByBranch: ReadonlyMap<string, BranchWorktreeRef>
): BranchRowsResult {
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
    const { matches, matchedTotal } = matchBranchesLiterally(
      branches,
      tokens.map((t) => t.toLowerCase())
    );
    return {
      rows: matches.map(({ option, matchRanges }) => enrich(option, 0, matchRanges)),
      matchedTotal,
    };
  }

  // Searched unbounded, then capped here, so `matchedTotal` can report how many
  // actually matched. Fuse's own `limit` would discard that count.
  const results = searchBranches(branches, query);

  return {
    rows: results.slice(0, RESULT_LIMIT).map((result) => {
      // Only `name` ranges are rendered: a hit that landed in `searchText`'s
      // trailing `(current)`/`(remote)` has no counterpart in the row, which now
      // draws those as separate badges instead of one baked string.
      const match = result.matches?.find((m) => m.key === "name");
      return enrich(result.item, result.score ?? 0, match?.indices ?? []);
    }),
    matchedTotal: results.length,
  };
}
