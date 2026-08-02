import type {
  ProjectSwitcherRow,
  SearchableProject,
  SearchableScratch,
} from "@/hooks/useProjectSwitcherPalette";

const NAME_WEIGHT = 4;

/**
 * One surviving word boundary: the {@link scoreField} boundary bonus (90) plus
 * the base score for the character that landed on it (10). Below that, a query
 * reached the end of the field without ever anchoring to the start of a word —
 * it scavenged its characters out of the middle of unrelated ones.
 */
const MIN_FILTER_MATCH_SCORE = 100;

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

/**
 * Whether `field` matches `query` well enough to survive a filter that will not
 * rank the result afterwards.
 *
 * The palette can afford a bare subsequence test — "fltsnp" finds "fleet
 * snapshot", and anything scraped together out of unrelated words sinks to the
 * bottom on score. A surface that only filters has no such backstop: every
 * survivor is presented as an equal answer, so "rust" pulling in "Research file
 * browser folder selection usability" (a legal subsequence worth 5 points) reads
 * as a result rather than as noise.
 *
 * The floor applies only to scattered matches. Anything the user typed
 * contiguously is a substring and collects that 500-point bonus outright, so
 * incremental typing — "d", "da", "dai" — never trips it, down to a single
 * character. What has to clear {@link MIN_FILTER_MATCH_SCORE} is a query whose
 * characters came from more than one word, and the ask is modest: land on one
 * word boundary and survive the gap penalties getting there.
 */
export function isFilterMatch(query: string, field: string): boolean {
  // An empty query is a substring of every field, so it would collect the
  // substring bonus and match everything. Callers filtering on a blank query
  // want all rows, but that is their short-circuit to make, not this one's.
  if (!query) return false;
  return scoreField(query, field) >= MIN_FILTER_MATCH_SCORE;
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
 * its path term, which is never negative.
 *
 * That a scratch containing the query outranks a loosely-matched project is a
 * consequence of the scores, not a guarantee. Long queries let a project's
 * per-character boundary bonuses plus a path hit overtake the substring bonus —
 * but only where the project's own name matches nearly as exactly, which is a
 * project that deserves the top slot anyway. Promoting substring quality into a
 * ranking tier would have to apply to every pair, projects included, or the
 * comparator stops being transitive.
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
