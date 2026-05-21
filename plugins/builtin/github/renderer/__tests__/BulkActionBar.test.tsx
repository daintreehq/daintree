/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { GitHubIssue, GitHubPR } from "@shared/types/github";

const openBulkCreateDialog = vi.fn();
const openBulkCreateDialogForPRs = vi.fn();

vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: (selector: (s: unknown) => unknown) =>
    selector({ openBulkCreateDialog, openBulkCreateDialogForPRs }),
}));

import { BulkActionBar } from "../components/BulkActionBar";

const makeIssue = (n: number): GitHubIssue => ({
  number: n,
  title: `Issue #${n}`,
  url: `https://github.com/test/repo/issues/${n}`,
  state: "OPEN",
  updatedAt: "2026-01-01",
  author: { login: "user", avatarUrl: "" },
  assignees: [],
  commentCount: 0,
});

const makePR = (n: number): GitHubPR => ({
  number: n,
  title: `PR #${n}`,
  url: `https://github.com/test/repo/pull/${n}`,
  state: "OPEN",
  isDraft: false,
  updatedAt: "2026-01-02",
  author: { login: "user", avatarUrl: "" },
});

beforeEach(() => {
  openBulkCreateDialog.mockReset();
  openBulkCreateDialogForPRs.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("BulkActionBar", () => {
  it("renders when issue selection is non-empty", () => {
    render(
      <BulkActionBar
        mode="issue"
        selectedIssues={[makeIssue(1), makeIssue(2)]}
        selectedPRs={[]}
        selectedCount={2}
        onClear={vi.fn()}
      />
    );

    expect(screen.getByRole("toolbar", { name: /bulk actions/i })).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
  });

  it("does not render when selection is empty", () => {
    // Plain conditional render (no AnimatePresence) — when count flips to 0
    // the bar must unmount immediately so it can't get stuck inside the
    // dropdown's Activity-hidden subtree. See `fixed-dropdown.tsx` invariant
    // comment.
    const { container } = render(
      <BulkActionBar
        mode="issue"
        selectedIssues={[]}
        selectedPRs={[]}
        selectedCount={0}
        onClear={vi.fn()}
      />
    );

    expect(screen.queryByRole("toolbar", { name: /bulk actions/i })).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  it("calls onClear when the X button is clicked", () => {
    const onClear = vi.fn();
    render(
      <BulkActionBar
        mode="issue"
        selectedIssues={[makeIssue(1)]}
        selectedPRs={[]}
        selectedCount={1}
        onClear={onClear}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /clear selection/i }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("opens bulk-create dialog with issues in issue mode", () => {
    const onClear = vi.fn();
    const issues = [makeIssue(1), makeIssue(2)];
    render(
      <BulkActionBar
        mode="issue"
        selectedIssues={issues}
        selectedPRs={[]}
        selectedCount={2}
        onClear={onClear}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /create worktrees/i }));
    expect(openBulkCreateDialog).toHaveBeenCalledWith(issues, onClear);
    expect(openBulkCreateDialogForPRs).not.toHaveBeenCalled();
  });

  it("opens bulk-create dialog with PRs in PR mode and uses PR count", () => {
    const onClear = vi.fn();
    const prs = [makePR(10), makePR(11), makePR(12)];
    render(
      <BulkActionBar
        mode="pr"
        selectedIssues={[makeIssue(99)]}
        selectedPRs={prs}
        selectedCount={3}
        onClear={onClear}
      />
    );

    expect(screen.getByText("3")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /create worktrees/i }));
    expect(openBulkCreateDialogForPRs).toHaveBeenCalledWith(prs, onClear);
    expect(openBulkCreateDialog).not.toHaveBeenCalled();
  });

  it("invokes onCloseDropdown after opening the dialog", () => {
    const onCloseDropdown = vi.fn();
    render(
      <BulkActionBar
        mode="issue"
        selectedIssues={[makeIssue(1)]}
        selectedPRs={[]}
        selectedCount={1}
        onClear={vi.fn()}
        onCloseDropdown={onCloseDropdown}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /create worktrees/i }));
    expect(onCloseDropdown).toHaveBeenCalledTimes(1);
  });
});
