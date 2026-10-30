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
  it("lets an exact diff stand without a banner or replacing it", () => {
    const notice = describeSinceReviewNotice(read({ kind: "exact", patch: "@@ -1 +1 @@" }));
    expect(notice).toEqual({ banner: null, replacesBody: false });
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

    expect(notice.banner?.title).toBe("Can't show the change since your review");
    expect(notice.banner?.description).toContain("The file has changed since your review.");
    expect(notice.replacesBody).toBe(true);
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

    // The baseline leads, in the title, ahead of any explanation.
    expect(notice.banner?.title).toBe("Showing changes since commit abcdef1");
    expect(notice.banner?.description).toContain("against the reviewed commit instead");
    expect(notice.replacesBody).toBe(false);
    expect(sinceReviewContent(outcome)).toBe("@@ -1 +1 @@\n-a\n+b\n");
  });

  it("doesn't claim a change it couldn't tell", () => {
    const notice = describeSinceReviewNotice(
      read({ kind: "unavailable", reason: "reviewed-not-covered", changed: false, standIn: null })
    );
    expect(notice.banner?.description).toContain("couldn't be told");
    expect(notice.banner?.description).not.toContain("has changed");
  });

  it("names an executable bit change in words rather than raw modes", () => {
    const notice = describeSinceReviewNotice(
      read({ kind: "mode-only", from: "100644", to: "100755" })
    );
    expect(notice.banner?.title).toBe("Made executable since your review");
    expect(JSON.stringify(notice)).not.toMatch(/1007|1006/);
  });
});

describe("SinceReviewNotice", () => {
  it("offers the other side only when both sides changed", () => {
    const onSideChange = vi.fn();
    const outcome = read({ kind: "exact", patch: "@@" }, { worktree: "changed", index: "changed" });
    const view = describeSinceReviewNotice(outcome);
    render(
      <SinceReviewNotice
        outcome={outcome}
        view={view}
        worktreeId={undefined}
        onSideChange={onSideChange}
        onRetry={() => {}}
      />
    );

    fireEvent.click(screen.getByRole("radio", { name: "Staged" }));

    expect(onSideChange).toHaveBeenCalledWith("index");
  });

  it("keeps the other side reachable when the chosen one went back to its reviewed state", () => {
    const outcome = read({ kind: "unchanged" }, { worktree: "changed", index: "unchanged" });
    if (outcome.status !== "read") throw new Error("expected read");
    const index: ReviewMarkFileSinceOutcome = { ...outcome, side: "index" };
    render(
      <SinceReviewNotice
        outcome={index}
        view={describeSinceReviewNotice(index)}
        worktreeId={undefined}
        onSideChange={() => {}}
        onRetry={() => {}}
      />
    );
    expect(screen.getByRole("radio", { name: "Working tree" })).toBeTruthy();
  });

  it("names an empty file added since review rather than saying nothing changed", () => {
    expect(
      describeSinceReviewNotice(read({ kind: "empty-file", change: "added" })).banner?.title
    ).toBe("Empty file added since your review");
  });

  it("shows no side switch for a single changed side", () => {
    const outcome = read({ kind: "exact", patch: "@@" });
    render(
      <SinceReviewNotice
        outcome={outcome}
        view={describeSinceReviewNotice(outcome)}
        worktreeId={undefined}
        onSideChange={() => {}}
        onRetry={() => {}}
      />
    );
    expect(screen.queryByTestId("since-review-side")).toBeNull();
    // The exact case draws no banner, only the quiet provenance line.
    expect(screen.queryByTestId("since-review-notice-banner")).toBeNull();
    expect(screen.getByTestId("since-review-provenance").textContent).toContain(
      "Since your review"
    );
  });

  it("offers Retry only where reading again could change the answer", () => {
    const onRetry = vi.fn();
    const transient = read({
      kind: "unavailable",
      reason: "current-unreadable",
      changed: false,
      standIn: null,
    });
    const { unmount } = render(
      <SinceReviewNotice
        outcome={transient}
        view={describeSinceReviewNotice(transient)}
        worktreeId={undefined}
        onSideChange={() => {}}
        onRetry={onRetry}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    unmount();

    const permanent = read({
      kind: "unavailable",
      reason: "reviewed-content-missing",
      changed: true,
      standIn: null,
    });
    render(
      <SinceReviewNotice
        outcome={permanent}
        view={describeSinceReviewNotice(permanent)}
        worktreeId={undefined}
        onSideChange={() => {}}
        onRetry={onRetry}
      />
    );
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});
