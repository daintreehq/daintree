import type { ActionFrecencyEntry } from "@shared/types/actions";

const TITLE_WEIGHT = 3;
const CATEGORY_WEIGHT = 1.5;
const DESCRIPTION_WEIGHT = 0.5;
const KEYWORD_WEIGHT = 1.0;
const MRU_BONUS_CAP = 50;
// tanh scale: `score` is now a rolling 7-day usage COUNT (shared/utils/actionUsage.ts),
// so heavy use tops out around 7 (1x-daily) to 14 (2x-daily). SCALE=7.5 maps that
// band to ~73-95% of cap while keeping CONTEXT_BOOST (80) > MRU bonus > 0. Revisit
// if the usage window (7 days) changes.
const MRU_SCORE_SCALE = 7.5;
const CONTEXT_BOOST = 80;
const GENERIC_CATEGORY = "general";

export interface SearchableAction {
  id: string;
  title: string;
  category: string;
  description: string;
  enabled: boolean;
  titleLower: string;
  categoryLower: string;
  descriptionLower: string;
  titleAcronym: string;
  keywordsLower: readonly string[];
}

export interface RankContext {
  focusedTerminalKind?: string;
  focusedWorktreeId?: string;
  isSettingsOpen?: boolean;
}

const TITLE_COLLATOR = new Intl.Collator("en", { sensitivity: "base" });

// Character-code equivalents of /[/\\\-._\s]/, /[a-z]/, /[A-Z]/ and
// /[a-zA-Z0-9]/ — this module runs per catalog entry on every palette
// keystroke, and per-character regex tests dominated its cost.
function isSeparatorCode(code: number): boolean {
  if (code < 128) {
    return (
      code === 32 ||
      (code >= 9 && code <= 13) ||
      code === 45 ||
      code === 46 ||
      code === 47 ||
      code === 92 ||
      code === 95
    );
  }
  return (
    code === 160 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

function isBoundary(str: string, index: number): boolean {
  if (index === 0) return true;
  const prev = str.charCodeAt(index - 1);
  if (isSeparatorCode(prev)) return true;
  if (prev >= 97 && prev <= 122) {
    const curr = str.charCodeAt(index);
    return curr >= 65 && curr <= 90;
  }
  return false;
}

export function extractAcronym(field: string): string {
  let acronym = "";
  for (let i = 0; i < field.length; i++) {
    const code = field.charCodeAt(i);
    const isAlnum =
      (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
    if (isAlnum && isBoundary(field, i)) {
      acronym += field.charAt(i).toLowerCase();
    }
  }
  return acronym;
}

export function scoreSubsequence(lowerQuery: string, field: string, lowerField: string): number {
  const qLen = lowerQuery.length;
  const fLen = lowerField.length;
  if (qLen > fLen) {
    return 0;
  }

  // One indexOf answers both the prefix and the substring bonus.
  const substringIdx = lowerField.indexOf(lowerQuery);

  // Single-character query: the greedy walk below reduces to exactly the first
  // occurrence, so its score is computable straight from that index. Short
  // queries are the palette's worst case (nearly every action survives them),
  // which makes this the hottest branch under real typing.
  if (qLen === 1) {
    if (substringIdx === -1) return 0;
    return (substringIdx === 0 ? 500 : 200) + (isBoundary(field, substringIdx) ? 90 : 0) + 10;
  }

  let score = 0;
  if (substringIdx === 0) {
    score += 500;
  } else if (substringIdx > 0) {
    score += 200;
  }

  let qi = 0;
  let queryCode = lowerQuery.charCodeAt(0);
  let lastMatchIndex = -1;
  let consecutiveRun = 0;

  for (let fi = 0; fi < fLen && qi < qLen; fi++) {
    if (lowerField.charCodeAt(fi) === queryCode) {
      if (lastMatchIndex >= 0) {
        const gap = fi - lastMatchIndex - 1;
        if (gap > 0) {
          score -= 20 + (gap - 1) * 5;
          consecutiveRun = 0;
        }
      }

      if (isBoundary(field, fi)) {
        score += 90;
      }

      if (lastMatchIndex >= 0 && fi === lastMatchIndex + 1) {
        consecutiveRun++;
        score += 10 * consecutiveRun;
      } else {
        consecutiveRun = 1;
        score += 10;
      }

      lastMatchIndex = fi;
      qi++;
      queryCode = lowerQuery.charCodeAt(qi);
    }
  }

  if (qi < qLen) {
    return 0;
  }

  return score;
}

function scoreTitle(
  lowerQuery: string,
  title: string,
  lowerTitle: string,
  acronym: string
): number {
  let score = scoreSubsequence(lowerQuery, title, lowerTitle);
  if (acronym.length > 0 && lowerQuery.length >= 2) {
    if (acronym === lowerQuery) {
      score += 300 + lowerQuery.length * 10;
    } else if (acronym.startsWith(lowerQuery)) {
      score += 200 + lowerQuery.length * 10;
    }
  }
  return score;
}

function scoreKeywords(lowerQuery: string, keywordsLower: readonly string[]): number {
  let max = 0;
  for (const kw of keywordsLower) {
    if (kw.length === 0) continue;
    const s = scoreSubsequence(lowerQuery, kw, kw);
    if (s > max) max = s;
  }
  return max;
}

export function scoreAction(query: string, item: SearchableAction): number {
  if (!query) return 0;
  const lowerQuery = query.toLowerCase();
  return scoreActionLower(lowerQuery, charMaskOf(lowerQuery), item, computeCharMasks([item]), 0);
}

function scoreActionLower(
  lowerQuery: string,
  queryMask: number,
  item: SearchableAction,
  charMasks: Int32Array,
  maskBase: number
): number {
  // A field whose fingerprint is missing any query character cannot contain
  // the query as a subsequence (the acronym's characters are a subset of the
  // title's, so the title mask covers the acronym branch too).
  const titleScore =
    (queryMask & ~charMasks[maskBase]!) === 0
      ? scoreTitle(lowerQuery, item.title, item.titleLower, item.titleAcronym)
      : 0;

  const categoryRaw =
    item.categoryLower === GENERIC_CATEGORY || (queryMask & ~charMasks[maskBase + 1]!) !== 0
      ? 0
      : scoreSubsequence(lowerQuery, item.category, item.categoryLower);

  const descriptionRaw =
    item.descriptionLower.length > 0 && (queryMask & ~charMasks[maskBase + 2]!) === 0
      ? scoreSubsequence(lowerQuery, item.description, item.descriptionLower)
      : 0;

  const keywordRaw =
    item.keywordsLower.length > 0 && (queryMask & ~charMasks[maskBase + 3]!) === 0
      ? scoreKeywords(lowerQuery, item.keywordsLower)
      : 0;

  if (titleScore <= 0 && categoryRaw <= 0 && descriptionRaw <= 0 && keywordRaw <= 0) return 0;

  return (
    titleScore * TITLE_WEIGHT +
    Math.max(0, categoryRaw) * CATEGORY_WEIGHT +
    Math.max(0, descriptionRaw) * DESCRIPTION_WEIGHT +
    Math.max(0, keywordRaw) * KEYWORD_WEIGHT
  );
}

export function getBoostedCategories(context: RankContext | undefined): Set<string> {
  const boosted = new Set<string>();
  if (!context) return boosted;

  const kind = context.focusedTerminalKind;
  if (kind) {
    switch (kind) {
      case "terminal":
        boosted.add("terminal");
        boosted.add("panel");
        break;
      case "agent":
        boosted.add("agent");
        boosted.add("terminal");
        boosted.add("panel");
        break;
      case "browser":
        boosted.add("browser");
        boosted.add("panel");
        break;
      case "dev-preview":
        boosted.add("devserver");
        boosted.add("panel");
        break;
      case "review":
        boosted.add("git");
        boosted.add("panel");
        break;
    }
  }

  if (
    typeof context.focusedWorktreeId === "string" &&
    context.focusedWorktreeId.trim().length > 0
  ) {
    boosted.add("worktree");
    boosted.add("git");
    boosted.add("forge");
  }

  if (context.isSettingsOpen) {
    boosted.add("settings");
    boosted.add("preferences");
  }

  return boosted;
}

// Collator tiebreaks are the sort's hot spot: Intl.Collator.compare costs
// orders of magnitude more than a numeric compare and integer usage counts
// make full ties common. Since one stable collator sort of the catalog yields
// per-position ranks whose numeric comparison reproduces the collator order
// exactly (collator-equal titles keep catalog order, same as a stable sort's
// 0-return), the ranks are computed once per catalog array and reused every
// keystroke. Ranks are positional (so duplicate item references stay exact)
// and guarded by an identity snapshot: any in-place mutation of the cached
// array — reorder, replacement, resize — is detected and triggers a recompute.
interface TitleRankCacheEntry {
  snapshot: readonly SearchableAction[];
  ranks: number[];
  charMasks: Int32Array;
}

const titleRankCache = new WeakMap<readonly SearchableAction[], TitleRankCacheEntry>();

function computeTitleRanks(items: readonly SearchableAction[]): TitleRankCacheEntry {
  const indices = items.map((_, index) => index);
  indices.sort((a, b) => TITLE_COLLATOR.compare(items[a]!.title, items[b]!.title));
  const ranks = new Array<number>(items.length);
  for (let rank = 0; rank < indices.length; rank++) {
    ranks[indices[rank]!] = rank;
  }
  return { snapshot: items.slice(), ranks, charMasks: computeCharMasks(items) };
}

function isSnapshotCurrent(
  snapshot: readonly SearchableAction[],
  items: readonly SearchableAction[]
): boolean {
  if (snapshot.length !== items.length) return false;
  for (let i = 0; i < items.length; i++) {
    if (snapshot[i] !== items[i]) return false;
  }
  return true;
}

export function rankActionMatches<T extends SearchableAction>(
  query: string,
  items: T[],
  mruList: readonly ActionFrecencyEntry[],
  context?: RankContext
): T[] {
  const lowerQuery = normalizeRankQuery(query);
  if (lowerQuery === undefined) return [];
  let cache = titleRankCache.get(items);
  if (!cache || !isSnapshotCurrent(cache.snapshot, items)) {
    cache = computeTitleRanks(items);
    titleRankCache.set(items, cache);
  }
  return rankActionMatchesWithTitleRanks(
    lowerQuery,
    items,
    cache.ranks,
    cache.charMasks,
    buildMruMap(mruList),
    getBoostedCategories(context)
  );
}

export type ActionRanker<T extends SearchableAction> = (
  query: string,
  mruList: readonly ActionFrecencyEntry[],
  context?: RankContext
) => T[];

export function createActionRanker<T extends SearchableAction>(
  items: readonly T[]
): ActionRanker<T> {
  let rankCache: TitleRankCacheEntry | undefined;
  let cachedMruList: readonly ActionFrecencyEntry[] | undefined;
  let cachedMruMap: ReadonlyMap<string, ActionFrecencyEntry> | undefined;
  let cachedTerminalKind: string | undefined;
  let cachedWorktreeId: string | undefined;
  let cachedSettingsOpen: boolean | undefined;
  let cachedBoostedCategories: ReadonlySet<string> | undefined;

  return (query, mruList, context) => {
    const lowerQuery = normalizeRankQuery(query);
    if (lowerQuery === undefined) return [];
    rankCache ??= computeTitleRanks(items);
    if (cachedMruList !== mruList) {
      cachedMruList = mruList;
      cachedMruMap = buildMruMap(mruList);
    }
    if (
      cachedBoostedCategories === undefined ||
      cachedTerminalKind !== context?.focusedTerminalKind ||
      cachedWorktreeId !== context?.focusedWorktreeId ||
      cachedSettingsOpen !== context?.isSettingsOpen
    ) {
      cachedTerminalKind = context?.focusedTerminalKind;
      cachedWorktreeId = context?.focusedWorktreeId;
      cachedSettingsOpen = context?.isSettingsOpen;
      cachedBoostedCategories = getBoostedCategories(context);
    }
    return rankActionMatchesWithTitleRanks(
      lowerQuery,
      items,
      rankCache.ranks,
      rankCache.charMasks,
      cachedMruMap!,
      cachedBoostedCategories
    );
  };
}

// 32-bit character fingerprints: bit i set when the field contains a character
// hashing to bit i (a-z map to bits 0-25, digits fold into bits 26-31; other
// characters contribute no bit, which keeps the test conservative). A query
// whose bits are not a subset of a field's bits cannot be a subsequence of it,
// so the per-item scoring loop can reject most fields with one AND instead of
// a character walk. Masks are computed once per catalog (they only depend on
// the precomputed *Lower fields) and reused every keystroke.
function charMaskOf(lower: string): number {
  let mask = 0;
  for (let i = 0; i < lower.length; i += 1) {
    const code = lower.charCodeAt(i);
    if (code >= 97 && code <= 122) {
      mask |= 1 << (code - 97);
    } else if (code >= 48 && code <= 57) {
      mask |= 1 << (26 + ((code - 48) % 6));
    }
  }
  return mask;
}

const MASK_STRIDE = 4;

function computeCharMasks(items: readonly SearchableAction[]): Int32Array {
  const masks = new Int32Array(items.length * MASK_STRIDE);
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i]!;
    const base = i * MASK_STRIDE;
    masks[base] = charMaskOf(item.titleLower);
    masks[base + 1] = charMaskOf(item.categoryLower);
    masks[base + 2] = charMaskOf(item.descriptionLower);
    let keywordMask = 0;
    for (const kw of item.keywordsLower) keywordMask |= charMaskOf(kw);
    masks[base + 3] = keywordMask;
  }
  return masks;
}

function normalizeRankQuery(query: string): string | undefined {
  const trimmed = query.trim();
  return trimmed ? trimmed.toLowerCase() : undefined;
}

function buildMruMap(
  mruList: readonly ActionFrecencyEntry[]
): ReadonlyMap<string, ActionFrecencyEntry> {
  const mruById = new Map<string, ActionFrecencyEntry>();
  for (const entry of mruList) mruById.set(entry.id, entry);
  return mruById;
}

function rankActionMatchesWithTitleRanks<T extends SearchableAction>(
  lowerQuery: string,
  items: readonly T[],
  titleRanks: readonly number[],
  charMasks: Int32Array,
  mruById: ReadonlyMap<string, ActionFrecencyEntry>,
  boostedCategories: ReadonlySet<string>
): T[] {
  const queryMask = charMaskOf(lowerQuery);
  const scored: Array<{ item: T; score: number; recency: number; rank: number }> = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const base = scoreActionLower(lowerQuery, queryMask, item, charMasks, i * MASK_STRIDE);
    if (base <= 0) continue;
    const mru = mruById.get(item.id);
    const mruBonus = mru ? MRU_BONUS_CAP * Math.tanh(mru.score / MRU_SCORE_SCALE) : 0;
    const contextBonus = boostedCategories.has(item.categoryLower) ? CONTEXT_BOOST : 0;
    scored.push({
      item,
      score: base + mruBonus + contextBonus,
      // Usage is now an integer count, so ties are common; break them by most
      // recent use so a recently-used-once action outranks a stale one.
      recency: mru?.lastAccessedAt ?? 0,
      rank: titleRanks[i]!,
    });
  }

  scored.sort((a, b) => {
    if (a.item.enabled !== b.item.enabled) return a.item.enabled ? -1 : 1;
    if (a.score !== b.score) return b.score - a.score;
    if (a.recency !== b.recency) return b.recency - a.recency;
    return a.rank - b.rank;
  });

  return scored.map((entry) => entry.item);
}
