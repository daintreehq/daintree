import { describe, expect, it } from "vitest";
import type {
  ReviewComparisonCommits,
  ReviewComparisonFile,
  ReviewComparisonResult,
} from "@shared/types/reviewComparison";
import type { ReviewMarkSummary } from "@shared/types/ipc/reviewMarks";
import type { WorktreeReviewMark } from "@/store/reviewMarksStore";
import { reviewChangeHint } from "../reviewChangeHint";

const COMMIT = "a".repeat(40);
const CAPTURED = 1_000_000;

function reviewMark(overrides: Partial<WorktreeReviewMark> = {}): WorktreeReviewMark {
  const mark: ReviewMarkSummary = {
    markedAt: CAPTURED + 5,
    capturedAt: CAPTURED,
    head: { kind: "branch", branch: "feature/x", commit: COMMIT },
    base: { ref: null, tip: null },
    complete: true,
    pathCount: 2,
    revision: 1,
  };
  return { mark, applicability: "applicable", ...overrides };
}

function file(
  index: ReviewComparisonFile["index"],
  worktree: ReviewComparisonFile["worktree"]
): ReviewComparisonFile {
  const side: ReviewComparisonFile["reviewed"] = { kind: "unlisted", entry: null };
  return {
    path: "a.ts",
    status: "modified",
    index,
    worktree,
    baseUpdate: "none",
    reviewed: side,
    current: side,
  };
}

const LISTED: ReviewComparisonCommits = {
  kind: "listed",
  history: "extended",
  commits: [],
  truncated: false,
};

function comparison(
  files: ReviewComparisonFile[],
  commits: ReviewComparisonCommits = LISTED,
  state: "comparable" | "incomplete" = "comparable"
): ReviewComparisonResult {
  const compared = {
    comparedAt: CAPTURED + 10,
    head: { kind: "branch", branch: "feature/x", commit: COMMIT } as const,
    base: {
      reviewed: { ref: null, tip: null, mergeBases: [] },
      current: { ref: null, tip: null, mergeBases: [] },
    },
    files,
    commits,
  };
  if (state === "incomplete") {
    return { state, reasons: ["path-limit"], gaps: [], ...compared };
  }
  return { state, ...compared };
}

describe("reviewChangeHint", () => {
  it("says nothing without a mark", () => {
    expect(reviewChangeHint(null, { headOid: "b".repeat(40) })).toBeNull();
  });

  it("says nothing for a mark from another branch", () => {
    const stale = reviewMark({ applicability: "branch-changed" });
    expect(reviewChangeHint(stale, { headOid: "b".repeat(40) })).toBeNull();
    expect(reviewChangeHint(reviewMark({ applicability: "branch-unknown" }), {})).toBeNull();
  });

  it("says nothing when nothing was observed", () => {
    expect(
      reviewChangeHint(reviewMark(), {
        headOid: COMMIT,
        latestFileMtime: CAPTURED,
        lastActivityTimestamp: CAPTURED - 10,
      })
    ).toBeNull();
    expect(reviewChangeHint(reviewMark(), {})).toBeNull();
  });

  it("raises the plain hint when HEAD moved", () => {
    expect(reviewChangeHint(reviewMark(), { headOid: "b".repeat(40) })).toBe(
      "Changed since review"
    );
  });

  it("raises the plain hint for file activity after the mark", () => {
    expect(reviewChangeHint(reviewMark(), { latestFileMtime: CAPTURED + 1 })).toBe(
      "Changed since review"
    );
    expect(reviewChangeHint(reviewMark(), { lastActivityTimestamp: CAPTURED + 1 })).toBe(
      "Changed since review"
    );
  });

  it("treats a commit appearing on a reviewed unborn branch as movement", () => {
    const unborn = reviewMark();
    unborn.mark.head = { kind: "unborn", branch: "feature/x" };
    expect(reviewChangeHint(unborn, { headOid: COMMIT })).toBe("Changed since review");
  });

  it("counts files only from a complete comparison", () => {
    const complete = comparison([
      file("unchanged", "changed"),
      file("changed", "unchanged"),
      file("unchanged", "unchanged"),
    ]);
    expect(reviewChangeHint(reviewMark(), {}, complete)).toBe("2 files since review");
    const one = comparison([file("unchanged", "changed")]);
    expect(reviewChangeHint(reviewMark(), {}, one)).toBe("1 file since review");
  });

  it("gives the plain hint when a comparable result can't be counted", () => {
    const unknown = comparison([file("unknown", "changed")]);
    expect(reviewChangeHint(reviewMark(), {}, unknown)).toBe("Changed since review");
    const noList = comparison([file("changed", "changed")], {
      kind: "unavailable",
      reason: "limit",
    });
    expect(reviewChangeHint(reviewMark(), {}, noList)).toBe("Changed since review");
  });

  it("never counts an incomplete comparison", () => {
    expect(
      reviewChangeHint(
        reviewMark(),
        {},
        comparison([file("changed", "changed")], LISTED, "incomplete")
      )
    ).toBe("Changed since review");
  });

  it("raises the hint for new commits with no changed files", () => {
    const commits: ReviewComparisonCommits = {
      ...LISTED,
      commits: [
        {
          oid: COMMIT,
          parents: [],
          subject: "s",
          authorName: "n",
          authorEmail: "e",
          authoredAt: CAPTURED + 1,
          kind: "new",
        },
      ],
    };
    expect(reviewChangeHint(reviewMark(), {}, comparison([], commits))).toBe(
      "Changed since review"
    );
  });

  it("makes no claim from a comparison that found nothing", () => {
    expect(reviewChangeHint(reviewMark(), {}, comparison([]))).toBeNull();
    const failed: ReviewComparisonResult = { state: "failed", reason: "deadline", message: "" };
    expect(reviewChangeHint(reviewMark(), {}, failed)).toBeNull();
  });
});
