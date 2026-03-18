/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { IssueBulkActionBar } from "../IssueBulkActionBar";
import type { GitHubIssue } from "@shared/types/github";

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn().mockResolvedValue({ ok: true }) },
}));

vi.mock("@/lib/notify", () => ({
  notify: vi.fn(),
}));

vi.mock("@/store/worktreeDataStore", () => ({
  useWorktreeDataStore: Object.assign(
    vi.fn((selector: (s: { worktrees: Map<string, unknown> }) => unknown) =>
      selector({ worktrees: new Map() })
    ),
    { getState: () => ({ worktrees: new Map() }) }
  ),
}));

vi.mock("@/components/Worktree/branchPrefixUtils", () => ({
  detectPrefixFromIssue: () => "feature",
  buildBranchName: (_prefix: string, slug: string) => `feature/${slug}`,
}));

vi.mock("@/utils/textParsing", () => ({
  generateBranchSlug: (title: string) => title.toLowerCase().replace(/\s+/g, "-"),
}));

vi.mock("../RecipePicker", () => ({
  RecipePicker: () => null,
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
  it("returns null when no issues selected and idle", () => {
    const { container } = render(<IssueBulkActionBar selectedIssues={[]} onClear={vi.fn()} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders toolbar with count badge and Create Worktrees button when issues selected", () => {
    const issues = [makeIssue(1), makeIssue(2), makeIssue(3)];
    render(<IssueBulkActionBar selectedIssues={issues} onClear={vi.fn()} />);

    const toolbar = screen.getByRole("toolbar", { name: "Bulk actions" });
    expect(toolbar).toBeTruthy();

    expect(screen.getByText("3")).toBeTruthy();
    expect(screen.getByText("Create Worktrees")).toBeTruthy();
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
    expect(classes).not.toContain("animate-pill-enter");

    expect(classes).toContain("border-t");
    expect(classes).toContain("shrink-0");
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
});
