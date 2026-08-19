import { classifyAssistantActivity } from "@/lib/projectAssistantActivity";
import type {
  ProjectSwitcherRow,
  SearchableProject,
  SearchableScratch,
  WorkspaceRowStatusFields,
} from "@/hooks/useProjectSwitcherPalette";

const NAME_WEIGHT = 4;

/**
 * What one word boundary is worth in {@link scoreField}: the boundary bonus
 * (90) plus the base score of the character that landed on it (10).
 *
 * It is a floor on the TOTAL, not proof that a boundary was hit — a query can
 * land on two of them and still come in under, because the gap penalties for
 * travelling between them outweigh what they paid. That is the intent: a match
 * has to be anchored to the words it came from AND stay near them.
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
 * The palette can afford a bare subsequence test — anything scraped together
 * out of unrelated words still sinks to the bottom on score. A surface that
 * only filters has no such backstop: every survivor is presented as an equal
 * answer, so "rust" pulling in "Research file browser folder selection
 * usability" (a legal subsequence worth 5 points) reads as a result rather than
 * as noise.
 *
 * The floor does not constrain contiguous typing: a literal substring is taken
 * before the score is consulted at all. The 500-point substring bonus cannot
 * carry that on its own, because {@link scoreField} adds it to the same running
 * total the greedy walk's gap penalties drain — past roughly 85 characters of
 * field a query that is literally the field's last word lands under 100, and
 * agent-set titles do reach that length. So incremental typing — "d", "da",
 * "dai" — never trips the floor, down to a single character. What has to clear
 * it is a query assembled from pieces.
 *
 * It inherits one flaw from {@link scoreField}: the walk is greedy, taking the
 * first character it can rather than the best one, so "sr" against
 * "issue-11518-scratch-rows" spends its "s" inside "issue", never reaches
 * "scratch rows", and scores 0. Reading word initials instead would recover
 * that case, but initials put no bound on the distance between the words they
 * come from — "test" would match "cut the external tool surface from 100 to
 * 24" — which is the bug this floor exists to close. Scoring the best
 * alignment rather than the first is the real fix, and it belongs in
 * {@link scoreField}, where the switcher's ranking would feel it too.
 */
export function isFilterMatch(query: string, field: string): boolean {
  // Trimmed here rather than trusted from the caller: whitespace is a substring
  // of every field, so a blank query would collect the substring bonus and
  // match everything. Callers that want all rows short-circuit on their own.
  const trimmed = query.trim();
  if (!trimmed) return false;
  // Case-folded the way scoreField folds it, so the two agree on what counts as
  // contiguous.
  if (field.toLowerCase().includes(trimmed.toLowerCase())) return true;
  return scoreField(trimmed, field) >= MIN_FILTER_MATCH_SCORE;
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
 * A scratch whose name contains the query outranking a loosely-matched project
 * no longer rests on these totals: {@link rankSwitcherMatches} compares a
 * name-match tier before it consults either one, and that tier applies to every
 * pair, projects included — which is what keeps the comparator transitive. The
 * totals are consulted only after both the tier and the activity keys have tied.
 *
 * One caveat inherited from {@link scoreField}: a scratch scoring 0 is filtered
 * out before any of that, and a long enough name drains the substring bonus to
 * nothing. The guarantee covers a substring match that still scores, not every
 * substring match.
 */
export function scoreScratchQuery(query: string, name: string): number {
  if (!query) return 0;

  const nameScore = scoreField(query, name);
  if (nameScore === 0) return 0;

  return NAME_WEIGHT * nameScore;
}

/** Projects sort ahead of scratches once every earlier key has tied. */
const KIND_RANK: Record<ProjectSwitcherRow["kind"], number> = { project: 0, scratch: 1 };

/**
 * How well a row's NAME answers the query, as a discrete tier.
 *
 * Read off the name STRING rather than off {@link scoreField}'s output, for two
 * reasons. Ranking by score alone is what #11861 was: four workspaces sharing a
 * prefix score identically at every prefix, because the walk stops the moment
 * the query is consumed and never looks at what trails it. And a class derived
 * from a project's TOTAL would see the path, which would scatter rows whose
 * names are equally good across several tiers on the strength of a directory
 * they merely happen to share — the "grouped before the path is consulted"
 * requirement, met structurally by never showing the path to this function.
 *
 * Discrete on purpose. Activity orders rows WITHIN a tier and can never lift one
 * out of it, so a scattered subsequence with five agents waiting still sits
 * below a clean prefix match with none. That is the contract every launcher
 * that gets this right shares (fzf's `--tiebreak`, `prescient.el`'s match
 * tiers): the secondary signal orders inside the class, it does not jump it.
 *
 * `exact` is not folded in with `prefix` even though every exact match is also a
 * prefix one: typing a workspace's whole name has to land on that workspace,
 * whatever the four projects it shares a prefix with are doing.
 */
const TEXT_CLASS_EXACT = 0;
const TEXT_CLASS_NAME_PREFIX = 1;
const TEXT_CLASS_NAME_SUBSTRING = 2;
const TEXT_CLASS_FUZZY_NAME = 3;
const TEXT_CLASS_PATH_ONLY = 4;

/**
 * `hasNameMatch` rather than a name score, because the only thing the last two
 * tiers turn on is whether the name matched at all. A scratch always passes it:
 * its total IS its name term ({@link scoreScratchQuery}), so a scratch that
 * scored at all matched its name, and `path-only` is structurally unreachable
 * for one — which is what keeps a scratch from ever picking up path relevance.
 */
function textQualityClass(lowerQuery: string, name: string, hasNameMatch: boolean): number {
  const lowerName = name.toLowerCase();
  if (lowerName === lowerQuery) return TEXT_CLASS_EXACT;
  if (lowerName.startsWith(lowerQuery)) return TEXT_CLASS_NAME_PREFIX;
  if (lowerName.includes(lowerQuery)) return TEXT_CLASS_NAME_SUBSTRING;
  return hasNameMatch ? TEXT_CLASS_FUZZY_NAME : TEXT_CLASS_PATH_ONLY;
}

const ACTIVITY_BLOCKED = 0;
const ACTIVITY_WAITING = 1;
const ACTIVITY_REVIEW = 2;
const ACTIVITY_WORKING = 3;
const ACTIVITY_QUIET = 4;

/**
 * What a workspace is asking of the user, reduced to the pair of numbers the
 * search comparator orders equally-well-matched rows by.
 *
 * `activityVolume` is only ever compared against another row in the SAME class,
 * so the counts it carries never have to be commensurable across classes.
 */
export interface SearchActivityKey {
  readonly activityClass: number;
  readonly activityVolume: number;
}

/**
 * Asking nothing. Also what a row absent from a frozen snapshot reads as — see
 * {@link rankSwitcherMatches}.
 */
export const QUIET_SEARCH_ACTIVITY: SearchActivityKey = {
  activityClass: ACTIVITY_QUIET,
  activityVolume: 0,
};

/**
 * The demand a row is making, on the same terms browse bands and tiers by
 * (`sectionForProject`/`attentionClass`) so the two modes cannot disagree about
 * what a workspace is doing while its status line says one thing either way.
 *
 * Workers are consulted before the assistant, exactly as `attentionClass` does
 * it: an escalated assistant tiers a row that nothing else was asking about,
 * and never re-tiers one a worker has already spoken for. The assistant is
 * worth exactly one unit and is never added to a worker tally (#11806).
 *
 * `blockedAgentCount` is a SUBSET of `waitingAgentCount`, so it is the volume of
 * its own class and is never summed alongside it.
 *
 * Deliberately blind to three signals, all of which are non-demanding in browse
 * and stay non-demanding here: `snoozedAgentCount` (the user already said not
 * yet), `completedAgentCount` (only the unacknowledged subset is an ask), and
 * `processCount` (residency, not intent).
 *
 * Snoozing does NOT withdraw a run from `activeAgentCount` — a snoozed worker
 * still counts as working, in main's tally and in browse's Running band alike
 * (`WorkspaceRowStatusFields`, `projectAgentCounts`). That asymmetry is the data
 * model's decision, not an oversight: snooze withholds a run from the tallies
 * that make a workspace read as DEMANDING — waiting, its blocked subset, and
 * unacknowledged completions, all three of which this function reads and all
 * three of which are already snooze-free. Netting snooze out of the working
 * class here would put search at odds with browse over the same row, and could
 * not be done soundly anyway: a snoozed COMPLETION would cancel an unrelated
 * live worker.
 */
export function computeSearchActivityKey(workspace: WorkspaceRowStatusFields): SearchActivityKey {
  if (workspace.blockedAgentCount > 0) {
    return { activityClass: ACTIVITY_BLOCKED, activityVolume: workspace.blockedAgentCount };
  }
  if (workspace.waitingAgentCount > 0) {
    return { activityClass: ACTIVITY_WAITING, activityVolume: workspace.waitingAgentCount };
  }

  const assistant = classifyAssistantActivity(workspace);
  if (assistant === "blocked") return { activityClass: ACTIVITY_BLOCKED, activityVolume: 1 };
  if (assistant === "waiting-unseen") return { activityClass: ACTIVITY_WAITING, activityVolume: 1 };

  if (workspace.unacknowledgedCompletedAgentCount > 0) {
    return {
      activityClass: ACTIVITY_REVIEW,
      activityVolume: workspace.unacknowledgedCompletedAgentCount,
    };
  }
  if (workspace.activeAgentCount > 0) {
    return { activityClass: ACTIVITY_WORKING, activityVolume: workspace.activeAgentCount };
  }
  if (assistant === "working") return { activityClass: ACTIVITY_WORKING, activityVolume: 1 };

  return QUIET_SEARCH_ACTIVITY;
}

interface RankedEntry {
  row: ProjectSwitcherRow;
  textClass: number;
  activity: SearchActivityKey;
  score: number;
  /** `frecencyScore` for a project, `lastOpened` for a scratch. Only ever compared same-kind. */
  recency: number;
}

/**
 * Ranks projects and scratches into the one array the palette renders, indexes
 * and walks with the arrow keys (#11071). Scratches are only ever ranked — in
 * browse they stay in their own pinned section, which is the caller's business.
 *
 * The comparator is a lexicographic tuple, which is what makes it transitive and
 * total — every key is a number or a string compared the same way for every
 * pair, and the last of them is the row id, so it returns 0 only for a row
 * against itself. A rule that reordered only SOME pairs (say, promoting a name
 * substring cross-kind while same-kind pairs stayed on raw score) would admit
 * cycles, and `Array.prototype.sort` on an intransitive comparator is
 * implementation-defined.
 *
 * In order: how well the NAME answers the query, then what the workspace is
 * asking of the user, then how loud that ask is, then the raw text score, then
 * kind, then per-kind recency, then name, then id. Activity sits below the name
 * tier and can never climb out of it (#11861), but it orders EVERY pair inside
 * one — including a pair the raw scores could have separated, which is the
 * point: those scores are what a shared parent directory decides.
 *
 * `activityKeys` is the palette session's frozen snapshot, keyed by row id.
 * Activity arrives live over IPC and every push re-runs this ranking, so reading
 * the rows' own counts would move a row out from under the pointer between the
 * moment the user decided to click and the moment they clicked — and would
 * change what Enter commits, since selection is the top row until the user
 * arrows. Passing `null` ranks against the rows' live counts instead, which is
 * what a caller ranking a fixed list wants. A row MISSING from a supplied
 * snapshot reads as {@link QUIET_SEARCH_ACTIVITY} rather than falling back to
 * its live counts: it arrived mid-session, and the whole point of the freeze is
 * that no row's position tracks a live push. It is folded into the snapshot on
 * the next commit and takes its real key from there.
 *
 * The parameter is required rather than optional so that omitting the snapshot
 * at the production call site is a compile error instead of a silent unfreeze.
 *
 * With an empty scratch list this still reduces to a project-only ranking, but
 * NOT to the old one: search now leads on match quality and activity rather than
 * on the blended score, which is the change (#11861).
 */
export function rankSwitcherMatches(
  query: string,
  projects: SearchableProject[],
  scratches: SearchableScratch[],
  activityKeys: ReadonlyMap<string, SearchActivityKey> | null
): ProjectSwitcherRow[] {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const lowerQuery = trimmed.toLowerCase();

  const activityFor = (workspace: WorkspaceRowStatusFields & { id: string }): SearchActivityKey =>
    activityKeys === null
      ? computeSearchActivityKey(workspace)
      : (activityKeys.get(workspace.id) ?? QUIET_SEARCH_ACTIVITY);

  const scored: RankedEntry[] = [];

  for (const project of projects) {
    const score = scoreProjectQuery(trimmed, project.name, project.path);
    if (score <= 0) continue;
    scored.push({
      row: { kind: "project", ...project },
      // Walks the name a second time rather than taking the term apart out of
      // `score`: how the two fields are weighted stays owned by
      // `scoreProjectQuery`, and names are short.
      textClass: textQualityClass(lowerQuery, project.name, scoreField(trimmed, project.name) > 0),
      activity: activityFor(project),
      score,
      recency: project.frecencyScore,
    });
  }
  for (const scratch of scratches) {
    const score = scoreScratchQuery(trimmed, scratch.name);
    if (score <= 0) continue;
    scored.push({
      row: { kind: "scratch", ...scratch },
      textClass: textQualityClass(lowerQuery, scratch.name, true),
      activity: activityFor(scratch),
      score,
      recency: scratch.lastOpened,
    });
  }

  scored.sort((a, b) => {
    if (a.textClass !== b.textClass) return a.textClass - b.textClass;
    if (a.activity.activityClass !== b.activity.activityClass) {
      return a.activity.activityClass - b.activity.activityClass;
    }
    if (a.activity.activityVolume !== b.activity.activityVolume) {
      return b.activity.activityVolume - a.activity.activityVolume;
    }
    if (a.score !== b.score) return b.score - a.score;
    if (a.row.kind !== b.row.kind) return KIND_RANK[a.row.kind] - KIND_RANK[b.row.kind];
    // Kinds are equal by here, so this never compares a frecency against a
    // timestamp — the two scales never have to be commensurable.
    if (a.recency !== b.recency) return b.recency - a.recency;
    const byName = a.row.name.localeCompare(b.row.name, undefined, { sensitivity: "base" });
    if (byName !== 0) return byName;
    // Ends on the id for the same reason `compareProjectsByMode` does: without
    // it two rows alike on every key above compare equal, and a sort that
    // reports a tie between distinct rows can seat them either way between
    // renders. Activity ties are far more common than score ties were.
    return a.row.id.localeCompare(b.row.id);
  });

  return scored.map((entry) => entry.row);
}
