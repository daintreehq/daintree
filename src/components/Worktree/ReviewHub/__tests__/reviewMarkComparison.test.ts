import { describe, expect, it } from "vitest";
import type { ReviewMarkCompareOutcome } from "@shared/types/ipc/reviewMarks";
import type {
  ReviewComparisonCommit,
  ReviewComparisonFile,
  ReviewComparisonResult,
} from "@shared/types/reviewComparison";
import {
  describeNotCovered,
  describeReviewMarkComparison,
  describeSinceReview,
  reviewMarkNoticeFor,
  sinceReviewUnavailableReason,
} from "../reviewMarkComparison";

const COMMIT = "1".repeat(40);

function file(path: string): ReviewComparisonFile {
  return {
    path,
    status: "modified",
    index: "unchanged",
    worktree: "changed",
    baseUpdate: "none",
    reviewed: { kind: "unlisted", entry: null },
    current: { kind: "unlisted", entry: null },
  };
}

function commit(kind: ReviewComparisonCommit["kind"] = "new"): ReviewComparisonCommit {
  return {
    oid: COMMIT,
    parents: [],
    subject: "change",
    authorName: "a",
    authorEmail: "a@example.com",
    authoredAt: 1,
    kind,
  };
}

const COMPARED = {
  comparedAt: 1,
  head: { kind: "branch" as const, branch: "feature", commit: COMMIT },
  base: {
    reviewed: { ref: null, tip: null, mergeBases: [] },
    current: { ref: null, tip: null, mergeBases: [] },
  },
};

function comparable(
  files: ReviewComparisonFile[],
  commits: ReviewComparisonCommit[],
  options: { truncated?: boolean; history?: "extended" | "rewritten" } = {}
): ReviewComparisonResult {
  return {
    state: "comparable",
    ...COMPARED,
    files,
    commits: {
      kind: "listed",
      history: options.history ?? "extended",
      commits,
      truncated: options.truncated ?? false,
    },
  };
}

function compared(result: ReviewComparisonResult): ReviewMarkCompareOutcome {
  return { status: "compared", markRevision: 3, result };
}

describe("describeReviewMarkComparison", () => {
  it("counts commits and files from a complete comparison", () => {
    expect(
      describeReviewMarkComparison(
        "applicable",
        compared(comparable([file("a.ts"), file("b.ts")], [commit(), commit(), commit()]))
      )
    ).toEqual({ kind: "counts", text: "3 new commits, 2 files since" });
    expect(
      describeReviewMarkComparison("applicable", compared(comparable([file("a.ts")], [])))
    ).toEqual({ kind: "counts", text: "1 file since" });
  });

  it("says nothing is new only for a complete comparison that found nothing", () => {
    expect(describeReviewMarkComparison("applicable", compared(comparable([], [])))).toEqual({
      kind: "nothing-new",
    });
    // A rewritten history with nothing new is still a change worth saying.
    expect(
      describeReviewMarkComparison(
        "applicable",
        compared(comparable([], [], { history: "rewritten" }))
      )
    ).toEqual({ kind: "counts", text: "History rewritten · Nothing new on this branch" });
  });

  it("counts only new commits and this branch's files", () => {
    expect(
      describeReviewMarkComparison(
        "applicable",
        compared(
          comparable(
            [file("own.ts"), { ...file("base.ts"), baseUpdate: "only" }],
            [commit("new"), commit("patch-equivalent")]
          )
        )
      )
    ).toEqual({ kind: "counts", text: "1 new commit, 1 file since" });
    expect(
      describeReviewMarkComparison(
        "applicable",
        compared(
          comparable([{ ...file("base.ts"), baseUpdate: "only" }], [commit("patch-equivalent")])
        )
      )
    ).toEqual({ kind: "counts", text: "Nothing new on this branch" });
  });

  it("gives no counts when the comparison is incomplete", () => {
    const incomplete = describeReviewMarkComparison(
      "applicable",
      compared({
        state: "incomplete",
        reasons: ["path-limit"],
        gaps: [],
        ...COMPARED,
        files: [file("a.ts")],
        commits: { kind: "listed", history: "extended", commits: [], truncated: false },
      })
    );
    const truncated = describeReviewMarkComparison(
      "applicable",
      compared(comparable([], [commit()], { truncated: true }))
    );
    const commitMissing = describeReviewMarkComparison(
      "applicable",
      compared({
        state: "reviewed-commit-missing",
        ...COMPARED,
        files: [],
        commits: { kind: "unavailable", reason: "reviewed-commit-missing" },
      })
    );
    const tooLarge = describeReviewMarkComparison("applicable", {
      status: "too-large",
      markRevision: 3,
    });

    for (const view of [incomplete, truncated, commitMissing]) {
      expect(view.kind).toBe("incomplete");
      expect(JSON.stringify(view)).not.toMatch(/\d+ (new )?commit/);
    }
    expect(tooLarge.kind).toBe("unavailable");
    // A cut-short commit list never says how many new commits there are, or
    // that there are none; the complete file list is still counted.
    expect(
      describeReviewMarkComparison(
        "applicable",
        compared(comparable([file("a.ts")], [commit("patch-equivalent")], { truncated: true }))
      )
    ).toEqual({ kind: "incomplete", text: "1 file since · too many commits to list" });
  });

  it("says a failed comparison failed, and waits out one a newer comparison replaced", () => {
    expect(
      describeReviewMarkComparison(
        "applicable",
        compared({ state: "failed", reason: "deadline", message: "slow" })
      ).kind
    ).toBe("failed");
    expect(
      describeReviewMarkComparison(
        "applicable",
        compared({ state: "failed", reason: "superseded", message: "newer" })
      ).kind
    ).toBe("comparing");
    expect(describeReviewMarkComparison("applicable", null).kind).toBe("comparing");
    expect(
      describeReviewMarkComparison("applicable", { status: "unavailable", markRevision: 3 }).kind
    ).toBe("unavailable");
  });

  it("never compares a mark made on another branch", () => {
    const result = compared(comparable([], []));
    expect(describeReviewMarkComparison("branch-changed", result).kind).toBe("other-branch");
    expect(describeReviewMarkComparison("branch-unknown", result).kind).toBe("branch-unknown");
    expect(
      describeReviewMarkComparison(
        "applicable",
        compared({ state: "different-branch", reviewed: COMPARED.head, current: COMPARED.head })
      ).kind
    ).toBe("other-branch");
  });
});

describe("reviewMarkNoticeFor", () => {
  it("names what changed after the hub read the worktree", () => {
    const notice = reviewMarkNoticeFor(
      compared(
        comparable([file("a.ts"), file("b.ts")], [commit("new"), commit("patch-equivalent")])
      )
    );

    expect(notice).toEqual({
      kind: "not-covered",
      paths: ["a.ts", "b.ts"],
      openablePaths: ["a.ts", "b.ts"],
      unchecked: 0,
      commits: 1,
      commitsTruncated: false,
      partial: false,
    });
  });

  it("counts a path neither side was seen to change as unchecked, not changed", () => {
    const notice = reviewMarkNoticeFor(
      compared(
        comparable([file("a.ts"), { ...file("b.ts"), index: "unknown", worktree: "unknown" }], [])
      )
    );
    expect(notice).toMatchObject({ kind: "not-covered", unchecked: 1 });
    if (notice?.kind !== "not-covered") throw new Error("expected a not-covered notice");
    expect(describeNotCovered(notice)).toBe(
      "1 file changed after Review Hub read the worktree. 1 file couldn't be checked."
    );
  });

  it("says nothing when the mark covers everything", () => {
    expect(reviewMarkNoticeFor(compared(comparable([], [])))).toBeNull();
  });

  it("says the check was partial or couldn't run", () => {
    expect(
      reviewMarkNoticeFor(
        compared({
          state: "incomplete",
          reasons: ["current-state-incomplete"],
          gaps: [],
          ...COMPARED,
          files: [],
          commits: { kind: "listed", history: "extended", commits: [], truncated: false },
        })
      )
    ).toEqual({
      kind: "not-covered",
      paths: [],
      openablePaths: [],
      unchecked: 0,
      commits: 0,
      commitsTruncated: false,
      partial: true,
    });
    expect(
      reviewMarkNoticeFor(compared({ state: "failed", reason: "git-failed", message: "x" }))
    ).toEqual({ kind: "unchecked" });
    expect(reviewMarkNoticeFor({ status: "unavailable", markRevision: 3 })).toEqual({
      kind: "unchecked",
    });
  });

  it("says how much changed, what couldn't be checked, and that a cut-short check is a floor", () => {
    expect(
      describeNotCovered({
        kind: "not-covered",
        paths: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"],
        openablePaths: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"],
        unchecked: 1,
        commits: 2,
        commitsTruncated: true,
        partial: true,
      })
    ).toBe(
      "4 files and at least 2 new commits changed after Review Hub read the worktree. 1 file couldn't be checked. The check didn't cover everything, so more may have changed."
    );
  });
});

describe("describeSinceReview", () => {
  const applicable = { mark: { head: COMPARED.head }, applicability: "applicable" as const };

  it("is unavailable, with the reason, without an applicable mark", () => {
    expect(sinceReviewUnavailableReason(null)).toBe("Mark this worktree reviewed first");
    expect(sinceReviewUnavailableReason({ applicability: "branch-unknown" })).toBe(
      "The worktree's branch isn't known yet"
    );
    expect(sinceReviewUnavailableReason({ applicability: "branch-changed" })).toBeNull();
    expect(describeSinceReview(null, null)).toEqual({ kind: "unavailable", reason: "no-mark" });
    expect(
      describeSinceReview({ mark: { head: COMPARED.head }, applicability: "branch-unknown" }, null)
    ).toEqual({ kind: "unavailable", reason: "branch-unknown" });
  });

  it("offers Clear for a mark from another branch, whatever the comparison says", () => {
    expect(
      describeSinceReview(
        {
          mark: { head: { kind: "branch", branch: "old", commit: COMMIT } },
          applicability: "branch-changed",
        },
        null
      )
    ).toEqual({ kind: "other-branch", markedOn: "old" });
    expect(
      describeSinceReview(
        { mark: { head: { kind: "detached", commit: COMMIT } }, applicability: "branch-changed" },
        null
      )
    ).toEqual({ kind: "other-branch", markedOn: null });
    expect(
      describeSinceReview(
        applicable,
        compared({ state: "different-branch", reviewed: COMPARED.head, current: COMPARED.head })
      ).kind
    ).toBe("other-branch");
  });

  it("is comparing until a comparison lands", () => {
    expect(describeSinceReview(applicable, null).kind).toBe("comparing");
    expect(describeSinceReview(applicable, { status: "none" }).kind).toBe("comparing");
    expect(
      describeSinceReview(
        applicable,
        compared({ state: "failed", reason: "superseded", message: "x" })
      ).kind
    ).toBe("comparing");
  });

  it("says nothing changed only for a complete comparison", () => {
    expect(describeSinceReview(applicable, compared(comparable([], []))).kind).toBe("empty");
    expect(
      describeSinceReview(applicable, compared(comparable([], [], { truncated: true }))).kind
    ).toBe("listed");
    expect(
      describeSinceReview(
        applicable,
        compared({
          state: "incomplete",
          reasons: ["path-limit"],
          gaps: [],
          ...COMPARED,
          files: [],
          commits: { kind: "listed", history: "extended", commits: [], truncated: false },
        })
      )
    ).toMatchObject({
      kind: "listed",
      incomplete: ["More files changed than can be listed."],
      filesPartial: true,
    });
  });

  it("doesn't say nothing changed when history was rewritten", () => {
    expect(
      describeSinceReview(applicable, compared(comparable([], [], { history: "rewritten" })))
    ).toMatchObject({ kind: "listed", commits: { rewritten: true } });
  });

  it("reports failed and unreadable comparisons apart from empty ones", () => {
    expect(
      describeSinceReview(
        applicable,
        compared({ state: "failed", reason: "git-failed", message: "x" })
      )
    ).toEqual({ kind: "failed", detail: "x" });
    expect(describeSinceReview(applicable, { status: "unavailable", markRevision: 3 })).toEqual({
      kind: "unreadable",
      cause: "unavailable",
    });
    expect(describeSinceReview(applicable, { status: "too-large", markRevision: 3 })).toEqual({
      kind: "unreadable",
      cause: "too-large",
    });
  });

  it("lists new and patch-equivalent commits apart and groups base-update files apart", () => {
    const view = describeSinceReview(
      applicable,
      compared(
        comparable(
          [
            file("own.ts"),
            { ...file("base.ts"), baseUpdate: "only" },
            { ...file("both.ts"), baseUpdate: "also" },
          ],
          [commit("new"), commit("patch-equivalent")],
          { history: "rewritten" }
        )
      )
    );
    expect(view).toMatchObject({
      kind: "listed",
      incomplete: null,
      filesPartial: false,
      commits: { kind: "listed", rewritten: true },
    });
    if (view.kind !== "listed" || view.commits.kind !== "listed") {
      throw new Error("expected a listed view");
    }
    expect(view.commits.fresh.map((c) => c.kind)).toEqual(["new"]);
    expect(view.commits.equivalent.map((c) => c.kind)).toEqual(["patch-equivalent"]);
    const row = { status: "modified", unverified: false };
    expect(view.files).toEqual([
      { ...row, path: "own.ts", group: "branch", alsoBaseUpdate: false },
      { ...row, path: "base.ts", group: "base-update", alsoBaseUpdate: false },
      { ...row, path: "both.ts", group: "branch", alsoBaseUpdate: true },
    ]);
  });

  it("keeps the files and says why commits are unavailable when the reviewed commit is gone", () => {
    const view = describeSinceReview(
      applicable,
      compared({
        state: "reviewed-commit-missing",
        ...COMPARED,
        files: [file("a.ts")],
        commits: { kind: "unavailable", reason: "reviewed-commit-missing" },
      })
    );
    // The file list is complete, so there's no banner: the commits band
    // says for itself why it's empty.
    expect(view).toMatchObject({
      kind: "listed",
      incomplete: null,
      filesPartial: false,
      commits: { kind: "unavailable" },
      files: [{ path: "a.ts" }],
    });
    expect(
      view.kind === "listed" && view.commits.kind === "unavailable" && view.commits.text
    ).toContain("reviewed commit no longer exists");
  });
});
