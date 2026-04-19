const TITLE_WEIGHT = 3;
const CATEGORY_WEIGHT = 1.5;
const DESCRIPTION_WEIGHT = 0.5;
const MRU_BONUS_CAP = 50;
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
}

function isBoundary(str: string, index: number): boolean {
  if (index === 0) return true;
  const prev = str[index - 1];
  const curr = str[index];
  return /[/\\\-._\s]/.test(prev) || (/[a-z]/.test(prev) && /[A-Z]/.test(curr));
}

export function extractAcronym(field: string): string {
  let acronym = "";
  for (let i = 0; i < field.length; i++) {
    const ch = field[i];
    if (/[a-zA-Z0-9]/.test(ch) && isBoundary(field, i)) {
      acronym += ch.toLowerCase();
    }
  }
  return acronym;
}

function scoreSubsequence(lowerQuery: string, field: string, lowerField: string): number {
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
    if (lowerField[fi] === lowerQuery[qi]) {
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

      if (fi === 0) {
        score += 20;
      }

      lastMatchIndex = fi;
      qi++;
    }
  }

  if (qi < lowerQuery.length) {
    return 0;
  }

  return Math.max(0, score);
}

function scoreTitle(lowerQuery: string, title: string, lowerTitle: string, acronym: string): number {
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

export function scoreAction(query: string, item: SearchableAction): number {
  if (!query) return 0;
  const lowerQuery = query.toLowerCase();

  const titleScore = scoreTitle(lowerQuery, item.title, item.titleLower, item.titleAcronym);

  const categoryRaw =
    item.categoryLower === GENERIC_CATEGORY
      ? 0
      : scoreSubsequence(lowerQuery, item.category, item.categoryLower);

  const descriptionRaw =
    item.descriptionLower.length > 0
      ? scoreSubsequence(lowerQuery, item.description, item.descriptionLower)
      : 0;

  if (titleScore === 0 && categoryRaw === 0 && descriptionRaw === 0) return 0;

  return (
    titleScore * TITLE_WEIGHT +
    categoryRaw * CATEGORY_WEIGHT +
    descriptionRaw * DESCRIPTION_WEIGHT
  );
}

export function rankActionMatches<T extends SearchableAction>(
  query: string,
  items: T[],
  mruList: readonly string[]
): T[] {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const mruIndex = new Map<string, number>();
  mruList.forEach((id, idx) => mruIndex.set(id, idx));
  const mruSize = mruList.length;

  const scored: Array<{ item: T; score: number }> = [];
  for (const item of items) {
    const base = scoreAction(trimmed, item);
    if (base <= 0) continue;
    const rank = mruIndex.get(item.id);
    const mruBonus =
      rank !== undefined && mruSize > 0 ? ((mruSize - rank) / mruSize) * MRU_BONUS_CAP : 0;
    scored.push({ item, score: base + mruBonus });
  }

  scored.sort((a, b) => {
    if (a.item.enabled !== b.item.enabled) return a.item.enabled ? -1 : 1;
    if (a.score !== b.score) return b.score - a.score;
    return a.item.title.localeCompare(b.item.title);
  });

  return scored.map((entry) => entry.item);
}
