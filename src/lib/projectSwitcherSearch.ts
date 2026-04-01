import type { SearchableProject } from "@/hooks/useProjectSwitcherPalette";

const NAME_WEIGHT = 4;

function isBoundary(str: string, index: number): boolean {
  if (index === 0) return true;
  const prev = str[index - 1];
  const curr = str[index];
  return /[/\\\-._\s]/.test(prev) || (/[a-z]/.test(prev) && /[A-Z]/.test(curr));
}

function scoreField(query: string, field: string): number {
  const lowerQuery = query.toLowerCase();
  const lowerField = field.toLowerCase();

  // Exact substring bonus
  let score = 0;
  if (lowerField.includes(lowerQuery)) {
    score += 500;
  }

  // Ordered subsequence match with scoring
  let qi = 0;
  let lastMatchIndex = -1;
  let consecutiveRun = 0;

  for (let fi = 0; fi < lowerField.length && qi < lowerQuery.length; fi++) {
    if (lowerField[fi] === lowerQuery[qi]) {
      // Gap penalty
      if (lastMatchIndex >= 0) {
        const gap = fi - lastMatchIndex - 1;
        if (gap > 0) {
          score -= 20 + (gap - 1) * 5;
          consecutiveRun = 0;
        }
      }

      // Word boundary bonus
      if (isBoundary(field, fi)) {
        score += 90;
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

  return score;
}

export function scoreProjectQuery(query: string, name: string, path: string): number {
  if (!query) return 0;

  const nameScore = scoreField(query, name);
  const pathScore = scoreField(query, path);

  if (nameScore === 0 && pathScore === 0) return 0;

  return NAME_WEIGHT * nameScore + pathScore;
}

export function rankProjectMatches(
  query: string,
  projects: SearchableProject[]
): SearchableProject[] {
  if (!query.trim()) return [];

  const scored = projects
    .map((project) => ({
      project,
      score: scoreProjectQuery(query, project.name, project.path),
    }))
    .filter((entry) => entry.score > 0);

  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    return b.project.lastOpened - a.project.lastOpened;
  });

  return scored.map((entry) => entry.project);
}
