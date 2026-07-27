import type {
  ProjectSwitcherRow,
  SearchableProject,
  SearchableScratch,
} from "@/hooks/useProjectSwitcherPalette";

const NAME_WEIGHT = 4;

function isBoundary(str: string, index: number): boolean {
  if (index === 0) return true;
  const prev = str[index - 1] ?? "";
  const curr = str[index] ?? "";
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

  return Math.max(0, score);
}

export function scoreProjectQuery(query: string, name: string, path: string): number {
  if (!query) return 0;

  const nameScore = scoreField(query, name);
  const pathScore = scoreField(query, path);

  if (nameScore === 0 && pathScore === 0) return 0;

  return NAME_WEIGHT * nameScore + pathScore;
}

/**
 * Scratches score on NAME ONLY. Their folders are UUID directories under
 * `userData`, so a path term would be pure noise — and matching one would let a
 * query that looks like a path hash surface every scratch at once.
 *
 * The same {@link NAME_WEIGHT} a project's name carries, so the two scales are
 * directly comparable: an equal name match leaves the project ahead by exactly
 * its path term (which is never negative), and a scratch whose name contains the
 * query clears a project that only matched loosely.
 */
export function scoreScratchQuery(query: string, name: string): number {
  if (!query) return 0;

  const nameScore = scoreField(query, name);
  if (nameScore === 0) return 0;

  return NAME_WEIGHT * nameScore;
}

/** Projects sort ahead of scratches on an exact score tie. */
const KIND_RANK: Record<ProjectSwitcherRow["kind"], number> = { project: 0, scratch: 1 };

/**
 * Ranks projects and scratches into the one array the palette renders, indexes
 * and walks with the arrow keys (#11071). Scratches are only ever ranked — in
 * browse they stay in their own pinned section, which is the caller's business.
 *
 * The comparator is a lexicographic tuple — score, then kind, then the per-kind
 * recency proxy — which makes it transitive and total. That matters: a rule that
 * reordered only CROSS-kind pairs (say, promoting a name substring over a loose
 * subsequence) while same-kind pairs stayed on raw score would admit cycles, and
 * `Array.prototype.sort` on an intransitive comparator is implementation-defined.
 *
 * With an empty scratch list this reduces exactly to the old project-only
 * ranking, so search order for a user without scratches is unchanged.
 */
export function rankSwitcherMatches(
  query: string,
  projects: SearchableProject[],
  scratches: SearchableScratch[]
): ProjectSwitcherRow[] {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const scored: { row: ProjectSwitcherRow; score: number }[] = [];

  for (const project of projects) {
    const score = scoreProjectQuery(trimmed, project.name, project.path);
    if (score > 0) scored.push({ row: { kind: "project", ...project }, score });
  }
  for (const scratch of scratches) {
    const score = scoreScratchQuery(trimmed, scratch.name);
    if (score > 0) scored.push({ row: { kind: "scratch", ...scratch }, score });
  }

  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.row.kind !== b.row.kind) return KIND_RANK[a.row.kind] - KIND_RANK[b.row.kind];
    if (a.row.kind === "project" && b.row.kind === "project") {
      return b.row.frecencyScore - a.row.frecencyScore;
    }
    return b.row.lastOpened - a.row.lastOpened;
  });

  return scored.map((entry) => entry.row);
}
