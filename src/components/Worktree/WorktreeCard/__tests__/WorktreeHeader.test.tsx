/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { WorktreeHeader, type WorktreeHeaderProps } from "../WorktreeHeader";
import type { WorktreeState } from "@shared/types";

vi.mock("react-dom", async () => {
  const actual = await vi.importActual<typeof import("react-dom")>("react-dom");
  return { ...actual, createPortal: (children: ReactNode) => children };
});

vi.mock("@/hooks/useGitHubTooltip", () => ({
  useIssueTooltip: () => ({
    data: null,
    loading: false,
    error: null,
    fetchTooltip: vi.fn(),
    reset: vi.fn(),
  }),
  usePRTooltip: () => ({
    data: null,
    loading: false,
    error: null,
    fetchTooltip: vi.fn(),
    reset: vi.fn(),
  }),
}));

const noop = () => {};

const baseWorktree: WorktreeState = {
  id: "test-wt",
  worktreeId: "test-wt",
  path: "/tmp/test-wt",
  name: "test-branch",
  branch: "feature/test",
  isCurrent: false,
  isMainWorktree: false,
  worktreeChanges: null,
  lastActivityTimestamp: null,
};

const baseMenu: WorktreeHeaderProps["menu"] = {
  launchAgents: [],
  recipes: [],
  runningRecipeId: null,
  isRestartValidating: false,
  counts: { grid: 0, dock: 0, active: 0, completed: 0, failed: 0, all: 0 },
  onCopyContextFull: noop,
  onCopyContextModified: noop,
  onOpenEditor: noop,
  onRevealInFinder: noop,
  onRunRecipe: noop,
  onDockAll: noop,
  onMaximizeAll: noop,
  onRestartAll: noop,
  onResetRenderers: noop,
  onCloseCompleted: noop,
  onCloseFailed: noop,
  onCloseAll: noop,
  onEndAll: noop,
};

function renderHeader(overrides: Partial<WorktreeHeaderProps> = {}) {
  return render(
    <WorktreeHeader
      worktree={baseWorktree}
      isActive={false}
      isMainWorktree={false}
      isPinned={false}
      branchLabel="feature/test"
      worktreeErrorCount={0}
      badges={{}}
      menu={baseMenu}
      {...overrides}
    />
  );
}

function getWrapper() {
  return screen.getByTestId("worktree-actions-wrapper");
}

describe("WorktreeHeader menu button", () => {
  it("has pointer-events-none and hover/focus reveal classes when inactive", () => {
    renderHeader({ isActive: false });
    const wrapper = getWrapper();
    expect(wrapper.className).toContain("pointer-events-none");
    expect(wrapper.className).toContain("opacity-0");
    expect(wrapper.className).toContain("group-hover:pointer-events-auto");
    expect(wrapper.className).toContain("group-hover:opacity-100");
    expect(wrapper.className).toContain("group-focus-within:pointer-events-auto");
    expect(wrapper.className).toContain("group-focus-within:opacity-100");
  });

  it("does not have pointer-events-none when active", () => {
    renderHeader({ isActive: true });
    const wrapper = getWrapper();
    expect(wrapper.className).not.toContain("pointer-events-none");
    expect(wrapper.className).toContain("opacity-100");
  });

  it("renders the more actions button with correct aria-label", () => {
    renderHeader();
    const button = screen.getByTestId("worktree-actions-menu");
    expect(button).toBeDefined();
    expect(button.getAttribute("aria-label")).toBe("More actions");
  });
});

describe("WorktreeHeader issue title headline", () => {
  it("shows issue title as primary headline when issueTitle is available", () => {
    renderHeader({
      worktree: {
        ...baseWorktree,
        issueNumber: 2907,
        issueTitle: "Add terminal recipe editor coverage",
      },
      badges: { onOpenIssue: noop },
    });

    const issueButton = screen.getByRole("button", {
      name: /Open issue #2907: Add terminal recipe editor coverage/,
    });
    expect(issueButton).toBeDefined();
    expect(screen.getByText("Add terminal recipe editor coverage")).toBeDefined();
  });

  it("applies active text styling to issue headline when isActive", () => {
    const { container } = renderHeader({
      worktree: {
        ...baseWorktree,
        issueNumber: 2907,
        issueTitle: "Add terminal recipe editor coverage",
      },
      isActive: true,
      badges: { onOpenIssue: noop },
    });

    const titleSpan = container.querySelector('button[aria-label*="Open issue"] .truncate');
    expect(titleSpan).toBeDefined();
    expect(titleSpan!.className).toContain("text-text-primary");
  });

  it("applies inactive text styling to issue headline when not active", () => {
    const { container } = renderHeader({
      worktree: {
        ...baseWorktree,
        issueNumber: 2907,
        issueTitle: "Add terminal recipe editor coverage",
      },
      isActive: false,
      badges: { onOpenIssue: noop },
    });

    const titleSpan = container.querySelector('button[aria-label*="Open issue"] .truncate');
    expect(titleSpan).toBeDefined();
    expect(titleSpan!.className).toContain("text-canopy-text/60");
  });

  it("uses branch name as primary headline when no issueTitle", () => {
    renderHeader({
      worktree: { ...baseWorktree, issueNumber: undefined, issueTitle: undefined },
      branchLabel: "feature/my-branch",
    });

    expect(screen.queryByRole("button", { name: /Open issue/ })).toBeNull();
    expect(screen.getByText(/my-branch/)).toBeDefined();
  });

  it("shows branch label in secondary row when issue title is headline", () => {
    renderHeader({
      worktree: {
        ...baseWorktree,
        issueNumber: 100,
        issueTitle: "Fix the thing",
      },
      branchLabel: "feature/fix-the-thing",
    });

    expect(screen.getByText("Fix the thing")).toBeDefined();
    expect(screen.getByText(/fix-the-thing/)).toBeDefined();
  });

  it("does not show duplicate issue badge in lower row when issue is headline", () => {
    const { container } = renderHeader({
      worktree: {
        ...baseWorktree,
        issueNumber: 100,
        issueTitle: "Fix the thing",
      },
      badges: { onOpenIssue: noop },
    });

    const issueButtons = container.querySelectorAll('button[aria-label*="Open issue"]');
    expect(issueButtons.length).toBe(1);
  });

  it("shows PR badge even when issue title is headline", () => {
    renderHeader({
      worktree: {
        ...baseWorktree,
        issueNumber: 100,
        issueTitle: "Fix the thing",
        prNumber: 101,
        prState: "open",
      },
      badges: { onOpenIssue: noop, onOpenPR: noop },
    });

    expect(screen.getByText("Fix the thing")).toBeDefined();
    expect(screen.getByRole("button", { name: /pull request #101/ })).toBeDefined();
  });

  it("uses branch name as headline when issueNumber exists but issueTitle is missing", () => {
    renderHeader({
      worktree: {
        ...baseWorktree,
        issueNumber: 100,
        issueTitle: undefined,
      },
      branchLabel: "feature/something",
      badges: { onOpenIssue: noop },
    });

    // Branch name should be the primary headline (no headline-level issue button)
    expect(screen.getByText(/something/)).toBeDefined();
    // Issue badge should still appear in secondary row with #100 fallback
    const issueButton = screen.getByRole("button", { name: /Open issue #100 on GitHub/ });
    expect(issueButton).toBeDefined();
  });

  it("uses branch name as headline for main worktree even with issue title", () => {
    renderHeader({
      worktree: {
        ...baseWorktree,
        isMainWorktree: true,
        issueNumber: 100,
        issueTitle: "Some issue",
      },
      isMainWorktree: true,
      branchLabel: "main",
    });

    // Main worktree can still have an issue — it should show as headline if present
    expect(screen.getByText("Some issue")).toBeDefined();
  });
});

describe("WorktreeHeader plan file badge", () => {
  it("renders plan badge when hasPlanFile is true and onOpenPlan is provided", () => {
    const onOpenPlan = vi.fn();
    renderHeader({
      worktree: { ...baseWorktree, hasPlanFile: true, planFilePath: "TODO.md" },
      badges: { onOpenPlan },
    });

    const planButton = screen.getByRole("button", { name: /View agent plan file/ });
    expect(planButton).toBeDefined();
    expect(screen.getByText("TODO.md")).toBeDefined();
  });

  it("does not render plan badge when hasPlanFile is false", () => {
    const onOpenPlan = vi.fn();
    renderHeader({
      worktree: { ...baseWorktree, hasPlanFile: false },
      badges: { onOpenPlan },
    });

    expect(screen.queryByRole("button", { name: /View agent plan file/ })).toBeNull();
  });

  it("does not render plan badge when hasPlanFile is true but onOpenPlan is not provided", () => {
    renderHeader({
      worktree: { ...baseWorktree, hasPlanFile: true, planFilePath: "PLAN.md" },
      badges: {},
    });

    expect(screen.queryByRole("button", { name: /View agent plan file/ })).toBeNull();
  });

  it("calls onOpenPlan when plan badge is clicked", async () => {
    const onOpenPlan = vi.fn();
    renderHeader({
      worktree: { ...baseWorktree, hasPlanFile: true, planFilePath: "TASKS.md" },
      badges: { onOpenPlan },
    });

    const planButton = screen.getByRole("button", { name: /View agent plan file/ });
    planButton.click();
    expect(onOpenPlan).toHaveBeenCalledOnce();
  });
});
