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

const SEPARATOR_RE = /[/\\\-._\s]/;
const LOWER_RE = /[a-z]/;
const UPPER_RE = /[A-Z]/;
const ALNUM_RE = /[a-zA-Z0-9]/;
const TITLE_COLLATOR = new Intl.Collator("en", { sensitivity: "base" });

function isBoundary(str: string, index: number): boolean {
  if (index === 0) return true;
  const prev = str.charAt(index - 1);
  const curr = str.charAt(index);
  return SEPARATOR_RE.test(prev) || (LOWER_RE.test(prev) && UPPER_RE.test(curr));
}

export function extractAcronym(field: string): string {
  let acronym = "";
  for (let i = 0; i < field.length; i++) {
    const ch = field.charAt(i);
    if (ALNUM_RE.test(ch) && isBoundary(field, i)) {
      acronym += ch.toLowerCase();
    }
  }
  return acronym;
}

export function scoreSubsequence(lowerQuery: string, field: string, lowerField: string): number {
  let score = 0;
  if (lowerField.includes(lowerQuery)) {
    score += 200;
    if (lowerField.startsWith(lowerQuery)) {
      score += 300;
    }
  }

  let qi = 0;
  let lastMatchIndex = -1;
  let consecutiveRun = 0;

  for (let fi = 0; fi < lowerField.length && qi < lowerQuery.length; fi++) {
    if (lowerField.charAt(fi) === lowerQuery.charAt(qi)) {
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
    }
  }

  if (qi < lowerQuery.length) {
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
  return scoreActionLower(query.toLowerCase(), item);
}

function scoreActionLower(lowerQuery: string, item: SearchableAction): number {
  const titleScore = scoreTitle(lowerQuery, item.title, item.titleLower, item.titleAcronym);

  const categoryRaw =
    item.categoryLower === GENERIC_CATEGORY
      ? 0
      : scoreSubsequence(lowerQuery, item.category, item.categoryLower);

  const descriptionRaw =
    item.descriptionLower.length > 0
      ? scoreSubsequence(lowerQuery, item.description, item.descriptionLower)
      : 0;

  const keywordRaw =
    item.keywordsLower.length > 0 ? scoreKeywords(lowerQuery, item.keywordsLower) : 0;

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

export function rankActionMatches<T extends SearchableAction>(
  query: string,
  items: T[],
  mruList: readonly ActionFrecencyEntry[],
  context?: RankContext
): T[] {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const lowerQuery = trimmed.toLowerCase();

  const mruScoreById = new Map<string, number>();
  const mruRecencyById = new Map<string, number>();
  mruList.forEach(({ id, score, lastAccessedAt }) => {
    mruScoreById.set(id, score);
    mruRecencyById.set(id, lastAccessedAt);
  });
  const boostedCategories = getBoostedCategories(context);

  const scored: Array<{ item: T; score: number }> = [];
  for (const item of items) {
    const base = scoreActionLower(lowerQuery, item);
    if (base <= 0) continue;
    const frecencyScore = mruScoreById.get(item.id);
    const mruBonus =
      frecencyScore !== undefined ? MRU_BONUS_CAP * Math.tanh(frecencyScore / MRU_SCORE_SCALE) : 0;
    const contextBonus = boostedCategories.has(item.categoryLower) ? CONTEXT_BOOST : 0;
    scored.push({ item, score: base + mruBonus + contextBonus });
  }

  scored.sort((a, b) => {
    if (a.item.enabled !== b.item.enabled) return a.item.enabled ? -1 : 1;
    if (a.score !== b.score) return b.score - a.score;
    // Usage is now an integer count, so ties are common; break them by most
    // recent use so a recently-used-once action outranks a stale one.
    const ra = mruRecencyById.get(a.item.id) ?? 0;
    const rb = mruRecencyById.get(b.item.id) ?? 0;
    if (ra !== rb) return rb - ra;
    return TITLE_COLLATOR.compare(a.item.title, b.item.title);
  });

  return scored.map((entry) => entry.item);
}
