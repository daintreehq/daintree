/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import type { ReactNode } from "react";
import { GitHubListItem } from "../GitHubListItem";
import type { GitHubIssue, GitHubPR } from "@shared/types/github";

vi.mock("react-dom", async () => {
  const actual = await vi.importActual<typeof import("react-dom")>("react-dom");
  return { ...actual, createPortal: (children: ReactNode) => children };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
vi.mock("@/store/worktreeDataStore", () => ({
  useWorktreeDataStore: vi.fn((selector: (s: { worktrees: Map<string, any> }) => unknown) =>
    selector({ worktrees: new Map() })
  ),
}));

vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: vi.fn((selector: (s: { activeWorktreeId: null }) => unknown) =>
    selector({ activeWorktreeId: null })
  ),
}));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn() },
}));

vi.mock("@/utils/timeAgo", () => ({
  formatTimeAgo: (date: string) => `time:${date}`,
}));

const baseIssue: GitHubIssue = {
  number: 42,
  title: "Fix the thing",
  url: "https://github.com/test/repo/issues/42",
  state: "OPEN",
  updatedAt: "2026-01-01",
  author: { login: "testuser", avatarUrl: "" },
  assignees: [],
  commentCount: 3,
};

const basePR: GitHubPR = {
  number: 99,
  title: "Add new feature",
  url: "https://github.com/test/repo/pull/99",
  state: "OPEN",
  isDraft: false,
  updatedAt: "2026-01-02",
  author: { login: "prauthor", avatarUrl: "" },
  headRefName: "feature/new-thing",
};

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("GitHubListItem", () => {
  it("renders issue title as a span", () => {
    render(<GitHubListItem item={baseIssue} type="issue" />);
    const title = screen.getByText("Fix the thing");
    expect(title.tagName).toBe("SPAN");
  });

  it("renders PR title as a span", () => {
    render(<GitHubListItem item={basePR} type="pr" />);
    const title = screen.getByText("Add new feature");
    expect(title.tagName).toBe("SPAN");
  });

  it("renders author and time in metadata row", () => {
    render(<GitHubListItem item={baseIssue} type="issue" />);
    expect(screen.getByText("testuser")).toBeTruthy();
    expect(screen.getByText("time:2026-01-01")).toBeTruthy();
  });

  it("renders branch name for PRs", () => {
    render(<GitHubListItem item={basePR} type="pr" />);
    expect(screen.getByText("feature/new-thing")).toBeTruthy();
  });

  it("renders labels for issues", () => {
    const issueWithLabels: GitHubIssue = {
      ...baseIssue,
      labels: [
        { name: "bug", color: "d73a4a" },
        { name: "enhancement", color: "a2eeef" },
      ],
    };
    render(<GitHubListItem item={issueWithLabels} type="issue" />);
    expect(screen.getByText("bug")).toBeTruthy();
    expect(screen.getByText("enhancement")).toBeTruthy();
  });

  it("clicking #number copies to clipboard", async () => {
    render(<GitHubListItem item={baseIssue} type="issue" />);
    const copyButton = screen.getByLabelText("Copy number 42");

    await act(async () => {
      fireEvent.click(copyButton);
    });

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("42");
  });

  it("shows check icon after copy then reverts after timeout", async () => {
    render(<GitHubListItem item={baseIssue} type="issue" />);
    const copyButton = screen.getByLabelText("Copy number 42");

    await act(async () => {
      fireEvent.click(copyButton);
    });

    // Check icon should be visible (status-success class)
    const checkIcon = copyButton.querySelector(".text-status-success");
    expect(checkIcon).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(1500);
    });

    // Check icon should be gone
    const checkIconAfter = copyButton.querySelector(".text-status-success");
    expect(checkIconAfter).toBeNull();
  });

  it("renders ellipsis menu trigger button", () => {
    render(<GitHubListItem item={baseIssue} type="issue" />);
    expect(screen.getByLabelText("More actions")).toBeTruthy();
  });

  it("ellipsis button is visible when isActive", () => {
    render(<GitHubListItem item={baseIssue} type="issue" isActive />);
    const btn = screen.getByLabelText("More actions");
    expect(btn.className).toContain("opacity-100");
  });

  it("ellipsis button is hidden when not active", () => {
    render(<GitHubListItem item={baseIssue} type="issue" isActive={false} />);
    const btn = screen.getByLabelText("More actions");
    expect(btn.className).toContain("opacity-0");
  });

  it("renders CI status dot for open PRs with ciStatus", () => {
    const prWithCI: GitHubPR = { ...basePR, ciStatus: "SUCCESS" };
    render(<GitHubListItem item={prWithCI} type="pr" />);
    expect(screen.getByLabelText("All checks passed")).toBeTruthy();
  });

  it("renders linked PR info for issues", () => {
    const issueWithPR: GitHubIssue = {
      ...baseIssue,
      linkedPR: { number: 55, state: "OPEN", url: "https://github.com/test/repo/pull/55" },
    };
    render(<GitHubListItem item={issueWithPR} type="issue" />);
    expect(screen.getByText("PR #55")).toBeTruthy();
  });

  it("renders #number badge", () => {
    render(<GitHubListItem item={baseIssue} type="issue" />);
    expect(screen.getByText("#42")).toBeTruthy();
  });

  it("applies selected state when isActive", () => {
    const { container } = render(<GitHubListItem item={baseIssue} type="issue" isActive />);
    const option = container.querySelector("[role='option']");
    expect(option?.getAttribute("aria-selected")).toBe("true");
    expect(option?.className).toContain("bg-muted/50");
  });
});
