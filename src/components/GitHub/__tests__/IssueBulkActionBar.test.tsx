/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { IssueBulkActionBar } from "../IssueBulkActionBar";
import type { GitHubIssue } from "@shared/types/github";

const mockOpenBulkCreateDialog = vi.fn();

vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: vi.fn((selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      openBulkCreateDialog: mockOpenBulkCreateDialog,
    })
  ),
}));

const makeIssue = (n: number): GitHubIssue => ({
  number: n,
  title: `Issue ${n}`,
  url: `https://github.com/test/repo/issues/${n}`,
  state: "OPEN",
  updatedAt: "2026-01-01",
  author: { login: "user", avatarUrl: "" },
  assignees: [],
  commentCount: 0,
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("IssueBulkActionBar", () => {
  it("returns null when no issues selected", () => {
    const { container } = render(<IssueBulkActionBar selectedIssues={[]} onClear={vi.fn()} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders toolbar with count badge and Create Worktrees button when issues selected", () => {
    const issues = [makeIssue(1), makeIssue(2), makeIssue(3)];
    render(<IssueBulkActionBar selectedIssues={issues} onClear={vi.fn()} />);

    const toolbar = screen.getByRole("toolbar", { name: "Bulk actions" });
    expect(toolbar).toBeTruthy();

    expect(screen.getByText("3")).toBeTruthy();
    const createBtn = screen.getByRole("button", { name: /Create Worktrees/i });
    expect(createBtn).toBeTruthy();
  });

  it("renders as inline footer row, not a floating pill", () => {
    const issues = [makeIssue(1)];
    render(<IssueBulkActionBar selectedIssues={issues} onClear={vi.fn()} />);

    const toolbar = screen.getByRole("toolbar");
    const classes = toolbar.className;

    expect(classes).not.toContain("absolute");
    expect(classes).not.toContain("rounded-full");
    expect(classes).not.toContain("backdrop-blur");
    expect(classes).not.toContain("bg-black");

    expect(classes).toContain("border-t");
    expect(classes).toContain("shrink-0");
  });

  it("shows 'selected' label next to count badge", () => {
    render(<IssueBulkActionBar selectedIssues={[makeIssue(1), makeIssue(2)]} onClear={vi.fn()} />);
    expect(screen.getByText("selected")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
  });

  it("calls onClear when dismiss button is clicked", () => {
    const onClear = vi.fn();
    render(<IssueBulkActionBar selectedIssues={[makeIssue(1)]} onClear={onClear} />);

    fireEvent.click(screen.getByLabelText("Clear selection"));
    expect(onClear).toHaveBeenCalled();
  });

  it("renders clear selection button with correct aria-label", () => {
    render(<IssueBulkActionBar selectedIssues={[makeIssue(1)]} onClear={vi.fn()} />);
    expect(screen.getByLabelText("Clear selection")).toBeTruthy();
  });

  it("opens bulk create dialog via store and closes dropdown when Create Worktrees is clicked", () => {
    const onCloseDropdown = vi.fn();
    const issues = [makeIssue(1), makeIssue(2)];
    render(
      <IssueBulkActionBar
        selectedIssues={issues}
        onClear={vi.fn()}
        onCloseDropdown={onCloseDropdown}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Create Worktrees/i }));

    expect(mockOpenBulkCreateDialog).toHaveBeenCalledWith(issues);
    expect(onCloseDropdown).toHaveBeenCalled();
  });
});
