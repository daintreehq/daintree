import type { ActionPaletteItem } from "@/hooks/useActionPalette";

const TITLE_WEIGHT = 2;
const CATEGORY_WEIGHT = 1.5;
const DESCRIPTION_WEIGHT = 1;

function isBoundary(str: string, index: number): boolean {
  if (index === 0) return true;
  const prev = str[index - 1] ?? "";
  const curr = str[index] ?? "";
  return /[/\\\-._\s]/.test(prev) || (/[a-z]/.test(prev) && /[A-Z]/.test(curr));
}

function scoreField(query: string, field: string): number {
  const lowerQuery = query.toLowerCase();
  const lowerField = field.toLowerCase();

  // Exact substring bonus (reduced to not overpower boundary matches)
  let score = 0;
  if (lowerField.includes(lowerQuery)) {
    score += 200;
  }

  // Ordered subsequence match with scoring
  let qi = 0;
  let lastMatchIndex = -1;
  let consecutiveRun = 0;
  const boundaryPositions: number[] = [];

  for (let fi = 0; fi < lowerField.length && qi < lowerQuery.length; fi++) {
    if (lowerField[fi] === lowerQuery[qi]) {
      const isBoundaryChar = isBoundary(field, fi);

      // Word boundary bonus
      if (isBoundaryChar) {
        score += 300;
        boundaryPositions.push(fi);
      }

      // Consecutive run bonus
      if (lastMatchIndex >= 0 && fi === lastMatchIndex + 1) {
        consecutiveRun++;
        score += 10 * consecutiveRun;
      } else {
        consecutiveRun = 1;
        score += 10;
      }

      // Match at start bonus
      if (fi === 0) {
        score += 20;
      }

      lastMatchIndex = fi;
      qi++;
    }
  }

  // If not all query chars matched, no valid subsequence
  if (qi < lowerQuery.length) {
    return 0;
  }

  // Compactness bonus for boundary matches (prefer shorter spans between boundaries)
  if (boundaryPositions.length > 1 && boundaryPositions[0] !== undefined) {
    const lastBoundary = boundaryPositions[boundaryPositions.length - 1];
    if (lastBoundary !== undefined) {
      const span = lastBoundary - boundaryPositions[0];
      const firstMatchBonus = Math.max(0, 100 - boundaryPositions[0] * 3);
      score += Math.max(0, 200 - span * 8) + firstMatchBonus;
    }
  }

  return Math.max(0, score);
}

function scoreActionQuery(
  query: string,
  title: string,
  category: string,
  description: string
): number {
  const titleScore = scoreField(query, title);
  const categoryScore = scoreField(query, category);
  const descriptionScore = scoreField(query, description);

  if (titleScore === 0 && categoryScore === 0 && descriptionScore === 0) {
    return 0;
  }

  return (
    TITLE_WEIGHT * titleScore +
    CATEGORY_WEIGHT * categoryScore +
    DESCRIPTION_WEIGHT * descriptionScore
  );
}

function scoreMultiTokenQuery(
  query: string,
  title: string,
  category: string,
  description: string
): number {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return 0;

  let totalScore = 0;

  for (const token of tokens) {
    const tokenScore = scoreActionQuery(token, title, category, description);
    if (tokenScore === 0) return 0; // All tokens must match
    totalScore += tokenScore;
  }

  return totalScore;
}

export interface ScoredAction {
  item: ActionPaletteItem;
  baseScore: number;
}

export function rankActionMatches(
  query: string,
  items: ActionPaletteItem[],
  mruMap: ReadonlyMap<string, number>
): ScoredAction[] {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const scored = items
    .map((item) => ({
      item,
      baseScore: scoreMultiTokenQuery(trimmed, item.title, item.category, item.description),
    }))
    .filter((entry) => entry.baseScore > 0);

  scored.sort((a, b) => {
    if (a.item.enabled !== b.item.enabled) return a.item.enabled ? -1 : 1;
    if (a.baseScore !== b.baseScore) return b.baseScore - a.baseScore;

    // MRU tiebreaker
    const aIndex = mruMap.get(a.item.id) ?? Infinity;
    const bIndex = mruMap.get(b.item.id) ?? Infinity;
    return aIndex - bIndex;
  });

  return scored;
}
