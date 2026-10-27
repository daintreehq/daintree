/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type {
  ReviewFileSinceView,
  ReviewMarkFileSinceOutcome,
} from "@shared/types/ipc/reviewMarks";
import { SinceReviewNotice, describeSinceReviewNotice } from "../SinceReviewNotice";
import { sinceReviewContent } from "../diffContentCache";

afterEach(cleanup);

function read(
  view: ReviewFileSinceView,
  changes: { worktree: "changed" | "unchanged"; index: "changed" | "unchanged" } = {
    worktree: "changed",
    index: "unchanged",
  }
): ReviewMarkFileSinceOutcome {
  return { status: "read", markRevision: 1, side: "worktree", changes, view };
}

describe("describeSinceReviewNotice", () => {
  it("lets an exact diff stand without replacing it", () => {
    const notice = describeSinceReviewNotice(read({ kind: "exact", patch: "@@ -1 +1 @@" }));
    expect(notice).toEqual({
      severity: "info",
      title: "Working tree since your review",
      replacesBody: false,
    });
  });

  it("says the reviewed version is unavailable and the file changed, with nothing to show", () => {
    // The revert-to-HEAD case: a HEAD-based diff would be empty.
    const outcome = read({
      kind: "unavailable",
      reason: "reviewed-content-missing",
      changed: true,
      standIn: null,
    });
    const notice = describeSinceReviewNotice(outcome);

    expect(notice?.title).toBe("Working tree: the reviewed version is unavailable");
    expect(notice?.description).toContain("This file changed since your review.");
    expect(notice?.replacesBody).toBe(true);
    expect(sinceReviewContent(outcome)).toBe("NO_CHANGES");
  });

  it("labels a stand-in diff as against the reviewed commit, never as the change since review", () => {
    const outcome = read({
      kind: "unavailable",
      reason: "reviewed-content-missing",
      changed: true,
      standIn: { commit: "abcdef1234567890", patch: "@@ -1 +1 @@\n-a\n+b\n" },
    });
    const notice = describeSinceReviewNotice(outcome);

    expect(notice?.description).toContain(
      "Showing the current version against the reviewed commit abcdef1, not the change since your review."
    );
    expect(notice?.replacesBody).toBe(false);
    expect(sinceReviewContent(outcome)).toBe("@@ -1 +1 @@\n-a\n+b\n");
  });

  it("doesn't claim a change it couldn't tell", () => {
    const notice = describeSinceReviewNotice(
      read({ kind: "unavailable", reason: "reviewed-not-covered", changed: false, standIn: null })
    );
    expect(notice?.description).toContain("couldn't be told");
    expect(notice?.description).not.toContain("This file changed");
  });
});

describe("SinceReviewNotice", () => {
  it("offers the other side only when both sides changed", () => {
    const onSideChange = vi.fn();
    const outcome = read({ kind: "exact", patch: "@@" }, { worktree: "changed", index: "changed" });
    const view = describeSinceReviewNotice(outcome)!;
    render(<SinceReviewNotice outcome={outcome} view={view} onSideChange={onSideChange} />);

    fireEvent.click(screen.getByRole("radio", { name: "Index" }));

    expect(onSideChange).toHaveBeenCalledWith("index");
  });

  it("keeps the other side reachable when the chosen one went back to its reviewed state", () => {
    const outcome = read({ kind: "unchanged" }, { worktree: "changed", index: "unchanged" });
    if (outcome.status !== "read") throw new Error("expected read");
    const index: ReviewMarkFileSinceOutcome = { ...outcome, side: "index" };
    render(
      <SinceReviewNotice
        outcome={index}
        view={describeSinceReviewNotice(index)!}
        onSideChange={() => {}}
      />
    );
    expect(screen.getByRole("radio", { name: "Working tree" })).toBeTruthy();
  });

  it("names an empty file added since review rather than saying nothing changed", () => {
    expect(describeSinceReviewNotice(read({ kind: "empty-file", change: "added" }))?.title).toBe(
      "Working tree: empty file added since your review"
    );
  });

  it("shows no side switch for a single changed side", () => {
    const outcome = read({ kind: "exact", patch: "@@" });
    render(
      <SinceReviewNotice
        outcome={outcome}
        view={describeSinceReviewNotice(outcome)!}
        onSideChange={() => {}}
      />
    );
    expect(screen.queryByTestId("since-review-side")).toBeNull();
  });
});
