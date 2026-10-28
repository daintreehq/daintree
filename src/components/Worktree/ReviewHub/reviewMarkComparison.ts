import type { ReviewMarkCompareOutcome } from "@shared/types/ipc/reviewMarks";
import type {
  ReviewComparisonCommit,
  ReviewComparisonCommits,
  ReviewComparisonFile,
  ReviewComparisonIncompleteReason,
} from "@shared/types/reviewComparison";
import type { ReviewMarkApplicability } from "@shared/utils/reviewMarkApplicability";
import { pluralize } from "@/lib/pluralize";

/**
 * What the review mark line says after "Reviewed … at …" (#14585). Counts come
 * only from a complete comparison of the worktree as it is now; anything less
 * says what's missing instead, and "nothing new" needs a complete one too.
 */
export type ReviewMarkComparisonView =
  | { kind: "comparing" }
  | { kind: "counts"; text: string }
  | { kind: "nothing-new" }
  | { kind: "incomplete"; text: string }
  | { kind: "other-branch" }
  | { kind: "branch-unknown" }
  | { kind: "unavailable"; text: string }
  | { kind: "failed"; text: string };

export const INCOMPLETE_TEXT: Record<ReviewComparisonIncompleteReason, string> = {
  "reviewed-point-incomplete": "the reviewed state wasn't read in full",
  "current-state-incomplete": "the worktree couldn't be read in full",
  "reviewed-state-unavailable": "the reviewed commit and its base are gone",
  "change-set-too-large": "too many changes to compare",
  "path-limit": "too many changed files to list",
  "commits-unavailable": "the commits couldn't be listed",
};

/** Failures that only mean a newer comparison took over; the hook asks again. */
export function isTransientComparisonFailure(outcome: ReviewMarkCompareOutcome): boolean {
  return (
    outcome.status === "compared" &&
    outcome.result.state === "failed" &&
    (outcome.result.reason === "superseded" || outcome.result.reason === "cancelled")
  );
}

/**
 * `outcome` is the newest comparison against the mark held now that nothing
 * has been seen to change since, or null while there's none.
 */
export function describeReviewMarkComparison(
  applicability: ReviewMarkApplicability,
  outcome: ReviewMarkCompareOutcome | null
): ReviewMarkComparisonView {
  if (applicability === "branch-changed") return { kind: "other-branch" };
  if (applicability === "branch-unknown") return { kind: "branch-unknown" };
  if (!outcome || outcome.status === "none" || isTransientComparisonFailure(outcome)) {
    return { kind: "comparing" };
  }
  if (outcome.status === "unavailable") {
    return { kind: "unavailable", text: "The reviewed state can't be read" };
  }
  if (outcome.status === "too-large") {
    return { kind: "incomplete", text: "Too many changes to compare" };
  }
  const { result } = outcome;
  switch (result.state) {
    case "different-branch":
      return { kind: "other-branch" };
    case "failed":
      return { kind: "failed", text: "Couldn't compare with the review" };
    case "incomplete":
      return {
        kind: "incomplete",
        text: `Comparison incomplete: ${INCOMPLETE_TEXT[result.reasons[0] ?? "current-state-incomplete"]}`,
      };
    case "reviewed-commit-missing":
      return {
        kind: "incomplete",
        text: "The reviewed commit is gone, so commits can't be counted",
      };
    case "comparable": {
      if (result.commits.kind !== "listed") {
        return { kind: "incomplete", text: "The commits couldn't be listed" };
      }
      if (result.commits.truncated) {
        return { kind: "incomplete", text: "Too many commits to count" };
      }
      const commits = result.commits.commits.length;
      const files = result.files.length;
      const rewritten = result.commits.history === "rewritten";
      if (commits === 0 && files === 0 && !rewritten) return { kind: "nothing-new" };
      const counts = [
        commits > 0 ? pluralize(commits, "commit") : null,
        files > 0 ? pluralize(files, "file") : null,
      ].filter((part): part is string => part !== null);
      const since = counts.length > 0 ? `${counts.join(", ")} since` : "no new files";
      return { kind: "counts", text: rewritten ? `History rewritten · ${since}` : since };
    }
  }
}

/**
 * What the hub says once a mark is recorded: what changed after the hub read
 * the worktree, and so isn't covered by the mark. `null` when nothing did.
 */
export type ReviewMarkNotice =
  | {
      kind: "not-covered";
      paths: string[];
      commits: number;
      /** The check didn't cover everything, so more may have changed. */
      partial: boolean;
    }
  | { kind: "unchecked" }
  | { kind: "other-branch" };

/** The notice for the first comparison against a new mark; never called with a transient one. */
export function reviewMarkNoticeFor(outcome: ReviewMarkCompareOutcome): ReviewMarkNotice | null {
  if (outcome.status === "none") return null;
  if (outcome.status !== "compared") return { kind: "unchecked" };
  const { result } = outcome;
  if (result.state === "different-branch") return { kind: "other-branch" };
  if (result.state === "failed") return { kind: "unchecked" };
  const commits =
    result.commits.kind === "listed"
      ? result.commits.commits.filter((commit) => commit.kind === "new").length
      : 0;
  const partial =
    result.state !== "comparable" || result.commits.kind !== "listed" || result.commits.truncated;
  if (result.files.length === 0 && commits === 0 && !partial) return null;
  return { kind: "not-covered", paths: result.files.map((file) => file.path), commits, partial };
}

const NOTICE_PATHS = 3;

/** One sentence for a not-covered notice: the first few paths, then a count. */
export function describeNotCovered(
  notice: Extract<ReviewMarkNotice, { kind: "not-covered" }>
): string {
  const parts: string[] = [];
  if (notice.paths.length > 0) {
    const shown = notice.paths.slice(0, NOTICE_PATHS).join(", ");
    const more = notice.paths.length - NOTICE_PATHS;
    parts.push(more > 0 ? `${shown} and ${pluralize(more, "more file")}` : shown);
  }
  if (notice.commits > 0) parts.push(pluralize(notice.commits, "new commit"));
  const listed = parts.length > 0 ? `Not covered: ${parts.join("; ")}.` : "";
  const partial = notice.partial ? " The check was incomplete, so more may have changed." : "";
  return `${listed}${partial}`.trim();
}

/** The part of the since-review view a file belongs to. */
export type SinceReviewFileGroup = "branch" | "base-update";

export interface SinceReviewFile {
  path: string;
  /** Present when the path isn't valid UTF-8; `path` is then a display form only. */
  pathBytes?: string;
  status: ReviewComparisonFile["status"];
  group: SinceReviewFileGroup;
  /** The base update changed this path and the branch touches it too. */
  alsoBaseUpdate: boolean;
}

export type SinceReviewCommitsView =
  | { kind: "listed"; rewritten: boolean; commits: ReviewComparisonCommit[]; truncated: boolean }
  | { kind: "unavailable"; text: string };

/**
 * What Review Hub's "Since review" view shows (#14586). The empty state is
 * only ever `empty` of a complete comparison; incomplete and failed ones have
 * their own kinds, and an incomplete one still lists what it found.
 */
export type SinceReviewView =
  | { kind: "unavailable"; reason: string }
  | { kind: "comparing" }
  | { kind: "other-branch" }
  | { kind: "failed"; text: string }
  | { kind: "unreadable"; text: string }
  | { kind: "empty" }
  | {
      kind: "listed";
      /** Why the lists may be missing something; null for a complete comparison. */
      incomplete: string | null;
      commits: SinceReviewCommitsView;
      files: SinceReviewFile[];
    };

const COMMITS_UNAVAILABLE_TEXT = {
  "reviewed-commit-missing": "The reviewed commit is gone, so commits can't be listed.",
  limit: "Too many commits to list.",
  unreadable: "The history couldn't be read in full, so commits can't be listed.",
  "base-unavailable":
    "The base the review was compared against is gone, so commits can't be listed.",
} as const;

/** Why the "Since review" view can't be opened, or null when it can. */
export function sinceReviewUnavailableReason(
  reviewMark: { applicability: ReviewMarkApplicability } | null
): string | null {
  if (!reviewMark) return "Mark this worktree reviewed first";
  if (reviewMark.applicability === "branch-unknown") return "The worktree's branch isn't known yet";
  return null;
}

export function describeSinceReview(
  reviewMark: { applicability: ReviewMarkApplicability } | null,
  outcome: ReviewMarkCompareOutcome | null
): SinceReviewView {
  const reason = sinceReviewUnavailableReason(reviewMark);
  if (reason !== null) return { kind: "unavailable", reason };
  if (reviewMark?.applicability === "branch-changed") return { kind: "other-branch" };
  if (!outcome || outcome.status === "none" || isTransientComparisonFailure(outcome)) {
    return { kind: "comparing" };
  }
  if (outcome.status === "unavailable") {
    return { kind: "unreadable", text: "The reviewed state can't be read." };
  }
  if (outcome.status === "too-large") {
    return { kind: "unreadable", text: "There are too many changes to compare." };
  }
  const { result } = outcome;
  switch (result.state) {
    case "different-branch":
      return { kind: "other-branch" };
    case "failed":
      return { kind: "failed", text: "Couldn't compare with the review." };
    case "incomplete":
    case "reviewed-commit-missing":
    case "comparable": {
      const files = result.files.map(sinceReviewFile);
      const commits = sinceReviewCommits(result.commits);
      const incomplete =
        result.state === "incomplete"
          ? `Comparison incomplete: ${result.reasons.map((r) => INCOMPLETE_TEXT[r]).join("; ")}.`
          : result.state === "reviewed-commit-missing"
            ? "The reviewed commit is gone, so commits can't be listed. The files below are complete."
            : commits.kind === "unavailable"
              ? "The commits couldn't be listed."
              : commits.truncated
                ? "Too many commits to list."
                : null;
      const noCommits = commits.kind === "listed" && commits.commits.length === 0;
      const rewritten = commits.kind === "listed" && commits.rewritten;
      if (incomplete === null && files.length === 0 && noCommits && !rewritten) {
        return { kind: "empty" };
      }
      return { kind: "listed", incomplete, commits, files };
    }
  }
}

function sinceReviewFile(file: ReviewComparisonFile): SinceReviewFile {
  return {
    path: file.path,
    ...(file.pathBytes !== undefined && { pathBytes: file.pathBytes }),
    status: file.status,
    group: file.baseUpdate === "only" ? "base-update" : "branch",
    alsoBaseUpdate: file.baseUpdate === "also",
  };
}

function sinceReviewCommits(commits: ReviewComparisonCommits): SinceReviewCommitsView {
  if (commits.kind === "unavailable") {
    return { kind: "unavailable", text: COMMITS_UNAVAILABLE_TEXT[commits.reason] };
  }
  return {
    kind: "listed",
    rewritten: commits.history === "rewritten",
    commits: commits.commits,
    truncated: commits.truncated,
  };
}
