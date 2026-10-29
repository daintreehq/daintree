import type { ReviewMarkCompareOutcome } from "@shared/types/ipc/reviewMarks";
import type {
  ReviewComparisonCommit,
  ReviewComparisonCommits,
  ReviewComparisonFile,
  ReviewComparisonIncompleteReason,
} from "@shared/types/reviewComparison";
import type { ReviewPointHead } from "@shared/types/reviewPoint";
import type { ReviewMarkApplicability } from "@shared/utils/reviewMarkApplicability";
import { pluralize } from "@/lib/pluralize";
import { formatTimeAgo } from "@/utils/timeAgo";

/**
 * What the review mark line says after "Reviewed … at …" (#14585). Counts come
 * only from a comparison complete for the list they count; anything less says
 * what's missing instead, and "nothing new" needs a complete one.
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

/**
 * One sentence per reason a comparison is incomplete, and which list it leaves
 * short. Review language rather than git's: what the user can't see, not why
 * git couldn't produce it.
 */
export const INCOMPLETE_REASON: Record<
  ReviewComparisonIncompleteReason,
  { list: "files" | "commits"; text: string }
> = {
  "reviewed-point-incomplete": {
    list: "files",
    text: "Your review mark didn't record every file, so changes to the others can't be shown.",
  },
  "current-state-incomplete": {
    list: "files",
    text: "Review Hub couldn't read the whole worktree this time.",
  },
  "reviewed-state-unavailable": {
    list: "files",
    text: "The reviewed commit and its base no longer exist, so files outside your reviewed changes can't be compared.",
  },
  "change-set-too-large": {
    list: "files",
    text: "There were too many changes to compare every file.",
  },
  "path-limit": { list: "files", text: "More files changed than can be listed." },
  "commits-unavailable": { list: "commits", text: "The commits couldn't be listed." },
};

/** How the hub names a mark in a sentence: its commit (or unborn branch) and its age. */
export function describeMarkPoint(
  mark: { head: ReviewPointHead; markedAt: number },
  now: number = Date.now()
): { point: string; ago: string } {
  return {
    point:
      mark.head.kind === "unborn" ? `the unborn ${mark.head.branch}` : mark.head.commit.slice(0, 7),
    ago: formatTimeAgo(mark.markedAt, now),
  };
}

/** Failures that only mean a newer comparison took over; the hook asks again. */
export function isTransientComparisonFailure(outcome: ReviewMarkCompareOutcome): boolean {
  return (
    outcome.status === "compared" &&
    outcome.result.state === "failed" &&
    (outcome.result.reason === "superseded" || outcome.result.reason === "cancelled")
  );
}

/** Commits whose change isn't already in the reviewed history. */
function newCommits(commits: ReviewComparisonCommit[]): number {
  return commits.filter((commit) => commit.kind === "new").length;
}

/** Files this branch changed, as opposed to ones only the base update did. */
function branchFiles(files: ReviewComparisonFile[]): number {
  return files.filter((file) => file.baseUpdate !== "only").length;
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
    return { kind: "unavailable", text: "Can't read the state you reviewed" };
  }
  if (outcome.status === "too-large") {
    return { kind: "unavailable", text: "Too many changes to compare" };
  }
  const { result } = outcome;
  switch (result.state) {
    case "different-branch":
      return { kind: "other-branch" };
    case "failed":
      return { kind: "failed", text: "Couldn't compare with your review" };
    case "incomplete":
      return { kind: "incomplete", text: "Some changes may not be listed" };
    case "reviewed-commit-missing": {
      const files = branchFiles(result.files);
      return {
        kind: "incomplete",
        text:
          files > 0
            ? `${pluralize(files, "file")} since · commits can't be listed`
            : "Commits since review can't be listed",
      };
    }
    case "comparable": {
      if (result.commits.kind !== "listed") {
        return { kind: "incomplete", text: "Some changes may not be listed" };
      }
      const commits = newCommits(result.commits.commits);
      const files = branchFiles(result.files);
      const { truncated } = result.commits;
      const rewritten = result.commits.history === "rewritten";
      const anyChange = result.commits.commits.length > 0 || result.files.length > 0 || rewritten;
      if (!anyChange) return { kind: "nothing-new" };
      // A truncated list can't say how many new commits there are, or that
      // there are none: what it left out may be exactly that.
      const counts = [
        truncated
          ? "more commits than can be listed"
          : commits > 0
            ? pluralize(commits, "new commit")
            : null,
        files > 0 ? pluralize(files, "file") : null,
      ].filter((part): part is string => part !== null);
      const since = counts.length > 0 ? `${counts.join(", ")} since` : "Nothing new on this branch";
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
      /** Every path the comparison listed, changed or not checked. */
      paths: string[];
      /** The paths a since-review diff can open: git spelled them in UTF-8. */
      openablePaths: string[];
      /** Of `paths`, how many couldn't be checked rather than were seen to change. */
      unchecked: number;
      commits: number;
      /** The commit list was cut short, so `commits` is a floor. */
      commitsTruncated: boolean;
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
  const commits = result.commits.kind === "listed" ? newCommits(result.commits.commits) : 0;
  const partial =
    result.state !== "comparable" || result.commits.kind !== "listed" || result.commits.truncated;
  if (result.files.length === 0 && commits === 0 && !partial) return null;
  return {
    kind: "not-covered",
    paths: result.files.map((file) => file.path),
    openablePaths: result.files
      .filter((file) => file.pathBytes === undefined)
      .map((file) => file.path),
    unchecked: result.files.filter(
      (file) => file.index !== "changed" && file.worktree !== "changed"
    ).length,
    commits,
    commitsTruncated: result.commits.kind === "listed" && result.commits.truncated,
    partial,
  };
}

/**
 * The sentence under a not-covered notice's title: how much changed after the
 * read, and whether the check saw everything.
 */
export function describeNotCovered(
  notice: Extract<ReviewMarkNotice, { kind: "not-covered" }>
): string {
  const changedFiles = notice.paths.length - notice.unchecked;
  const parts = [
    changedFiles > 0 ? pluralize(changedFiles, "file") : null,
    notice.commits > 0
      ? `${notice.commitsTruncated ? "at least " : ""}${pluralize(notice.commits, "new commit")}`
      : null,
  ].filter((part): part is string => part !== null);
  const sentences = [
    parts.length > 0 ? `${parts.join(" and ")} changed after Review Hub read the worktree.` : null,
    notice.unchecked > 0 ? `${pluralize(notice.unchecked, "file")} couldn't be checked.` : null,
    notice.partial ? "The check didn't cover everything, so more may have changed." : null,
  ].filter((sentence): sentence is string => sentence !== null);
  return sentences.join(" ");
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
  /** Listed because it couldn't be checked, not because it was seen to change. */
  unverified: boolean;
}

export type SinceReviewCommitsView =
  | {
      kind: "listed";
      rewritten: boolean;
      /** Commits whose change isn't in the reviewed history, newest first. */
      fresh: ReviewComparisonCommit[];
      /** Same change as a commit in the reviewed history: rebased or cherry-picked copies. */
      equivalent: ReviewComparisonCommit[];
      truncated: boolean;
    }
  | { kind: "unavailable"; text: string };

/**
 * What Review Hub's "Since review" view shows (#14586). The empty state is
 * only ever `empty` of a complete comparison; incomplete and failed ones have
 * their own kinds, and an incomplete one still lists what it found.
 */
export type SinceReviewView =
  | { kind: "unavailable"; reason: "no-mark" | "branch-unknown" }
  | { kind: "comparing" }
  /** `markedOn` is the mark's branch, or null for a detached HEAD. */
  | { kind: "other-branch"; markedOn: string | null }
  | { kind: "failed"; detail: string | null }
  | { kind: "unreadable"; cause: "unavailable" | "too-large" }
  | { kind: "empty" }
  | {
      kind: "listed";
      /** One sentence per reason the lists may be short; null for a complete comparison. */
      incomplete: string[] | null;
      /** More files may have changed than are listed. */
      filesPartial: boolean;
      commits: SinceReviewCommitsView;
      files: SinceReviewFile[];
    };

const COMMITS_UNAVAILABLE_TEXT = {
  "reviewed-commit-missing":
    "The reviewed commit no longer exists, so commits since it can't be listed.",
  limit: "Too many commits to list.",
  unreadable: "Git couldn't read the whole history, so commits can't be listed.",
  "base-unavailable":
    "The base branch the review was compared with no longer resolves, so commits can't be listed.",
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
  reviewMark: { mark: { head: ReviewPointHead }; applicability: ReviewMarkApplicability } | null,
  outcome: ReviewMarkCompareOutcome | null
): SinceReviewView {
  if (!reviewMark) return { kind: "unavailable", reason: "no-mark" };
  if (reviewMark.applicability === "branch-unknown") {
    return { kind: "unavailable", reason: "branch-unknown" };
  }
  const markedOn = reviewMark.mark.head.kind === "detached" ? null : reviewMark.mark.head.branch;
  if (reviewMark.applicability === "branch-changed") return { kind: "other-branch", markedOn };
  if (!outcome || outcome.status === "none" || isTransientComparisonFailure(outcome)) {
    return { kind: "comparing" };
  }
  if (outcome.status === "unavailable") return { kind: "unreadable", cause: "unavailable" };
  if (outcome.status === "too-large") return { kind: "unreadable", cause: "too-large" };
  const { result } = outcome;
  switch (result.state) {
    case "different-branch":
      return { kind: "other-branch", markedOn };
    case "failed":
      return { kind: "failed", detail: result.message.trim() || null };
    case "incomplete":
    case "reviewed-commit-missing":
    case "comparable": {
      const files = result.files.map(sinceReviewFile);
      const commits = sinceReviewCommits(result.commits);
      const reasons = result.state === "incomplete" ? result.reasons : [];
      // The commits band says for itself why it's empty; the banner speaks only
      // for what the bands can't show.
      const incomplete = reasons
        .filter((reason) => INCOMPLETE_REASON[reason].list === "files" || commits.kind === "listed")
        .map((reason) => INCOMPLETE_REASON[reason].text);
      const filesPartial = reasons.some((reason) => INCOMPLETE_REASON[reason].list === "files");
      const noCommits =
        commits.kind === "listed" && commits.fresh.length === 0 && commits.equivalent.length === 0;
      const rewritten = commits.kind === "listed" && commits.rewritten;
      const complete =
        result.state === "comparable" && commits.kind === "listed" && !commits.truncated;
      if (complete && files.length === 0 && noCommits && !rewritten) return { kind: "empty" };
      return {
        kind: "listed",
        incomplete: incomplete.length > 0 ? incomplete : null,
        filesPartial,
        commits,
        files,
      };
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
    unverified: file.index !== "changed" && file.worktree !== "changed",
  };
}

function sinceReviewCommits(commits: ReviewComparisonCommits): SinceReviewCommitsView {
  if (commits.kind === "unavailable") {
    return { kind: "unavailable", text: COMMITS_UNAVAILABLE_TEXT[commits.reason] };
  }
  return {
    kind: "listed",
    rewritten: commits.history === "rewritten",
    fresh: commits.commits.filter((commit) => commit.kind === "new"),
    equivalent: commits.commits.filter((commit) => commit.kind === "patch-equivalent"),
    truncated: commits.truncated,
  };
}
