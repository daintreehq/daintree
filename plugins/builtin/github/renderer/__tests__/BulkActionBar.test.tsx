/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { Issue, PR } from "@shared/types/forge";

const openBulkCreateDialog = vi.fn();
const openBulkCreateDialogForPRs = vi.fn();

vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: (selector: (s: unknown) => unknown) =>
    selector({ openBulkCreateDialog, openBulkCreateDialogForPRs }),
}));

import { BulkActionBar } from "../components/BulkActionBar";

const makeIssue = (n: number): Issue => ({
  number: n,
  title: `Issue #${n}`,
  body: "",
  url: `https://github.com/test/repo/issues/${n}`,
  state: "open",
  rawState: "OPEN",
  author: { login: "user", avatarUrl: "", rawData: null },
  assignees: [],
  labels: [],
  commentCount: 0,
  createdAt: 0,
  updatedAt: 0,
  rawData: null,
});

const makePR = (n: number): PR => ({
  number: n,
  title: `PR #${n}`,
  body: "",
  url: `https://github.com/test/repo/pull/${n}`,
  state: "open",
  rawState: "OPEN",
  isDraft: false,
  merged: false,
  author: { login: "user", avatarUrl: "", rawData: null },
  baseRef: "main",
  headRef: `feature/pr-${n}`,
  createdAt: 0,
  updatedAt: 0,
  rawData: null,
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

    expect(screen.getByRole("group", { name: /bulk actions/i })).toBeTruthy();
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

    expect(screen.queryByRole("group", { name: /bulk actions/i })).toBeNull();
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

    fireEvent.click(screen.getByRole("button", { name: /create worktree/i }));
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

    fireEvent.click(screen.getByRole("button", { name: /create worktree/i }));
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

    fireEvent.click(screen.getByRole("button", { name: /create worktree/i }));
    expect(onCloseDropdown).toHaveBeenCalledTimes(1);
  });
});
