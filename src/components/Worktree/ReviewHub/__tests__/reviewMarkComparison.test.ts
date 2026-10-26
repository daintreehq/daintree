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
  reviewMarkNoticeFor,
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
    ).toEqual({ kind: "counts", text: "3 commits, 2 files since" });
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
    ).toEqual({ kind: "counts", text: "History rewritten · no new files" });
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

    for (const view of [incomplete, truncated, commitMissing, tooLarge]) {
      expect(view.kind).toBe("incomplete");
      expect(JSON.stringify(view)).not.toMatch(/\d+ (commit|file)/);
    }
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
      compared(comparable([file("a.ts"), file("b.ts")], [commit("new"), commit("patch-equivalent")]))
    );

    expect(notice).toEqual({
      kind: "not-covered",
      paths: ["a.ts", "b.ts"],
      commits: 1,
      partial: false,
    });
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
    ).toEqual({ kind: "not-covered", paths: [], commits: 0, partial: true });
    expect(
      reviewMarkNoticeFor(compared({ state: "failed", reason: "git-failed", message: "x" }))
    ).toEqual({ kind: "unchecked" });
    expect(reviewMarkNoticeFor({ status: "unavailable", markRevision: 3 })).toEqual({
      kind: "unchecked",
    });
  });

  it("lists the first few paths, then a count", () => {
    expect(
      describeNotCovered({
        kind: "not-covered",
        paths: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"],
        commits: 2,
        partial: true,
      })
    ).toBe(
      "Not covered: a.ts, b.ts, c.ts and 2 more files; 2 new commits. The check was incomplete, so more may have changed."
    );
  });
});
