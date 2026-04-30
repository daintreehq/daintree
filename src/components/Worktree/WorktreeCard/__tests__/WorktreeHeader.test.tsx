/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { ReactNode } from "react";
import { WorktreeHeader, type WorktreeHeaderProps } from "../WorktreeHeader";
import type { WorktreeState } from "@shared/types";
import { TooltipProvider } from "@/components/ui/tooltip";
import { actionService } from "@/services/ActionService";

vi.mock("react-dom", async () => {
  const actual = await vi.importActual<typeof import("react-dom")>("react-dom");
  return { ...actual, createPortal: (children: ReactNode) => children };
});

let mockMissingToken = false;

vi.mock("@/hooks/useGitHubTooltip", () => ({
  useIssueTooltip: () => ({
    data: null,
    loading: false,
    error: null,
    missingToken: mockMissingToken,
    fetchTooltip: vi.fn(),
    reset: vi.fn(),
  }),
  usePRTooltip: () => ({
    data: null,
    loading: false,
    error: null,
    missingToken: mockMissingToken,
    fetchTooltip: vi.fn(),
    reset: vi.fn(),
  }),
}));

vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: vi.fn(),
  },
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
  counts: { grid: 0, dock: 0, active: 0, completed: 0, all: 0, waiting: 0, working: 0 },
  onCopyContextFull: noop,
  onCopyContextModified: noop,
  onCopyPath: noop,
  onOpenEditor: noop,
  onRevealInFinder: noop,
  onRunRecipe: noop,
  onDockAll: noop,
  onMaximizeAll: noop,
  onResetRenderers: noop,
  onSelectAllAgents: noop,
  onSelectWaitingAgents: noop,
  onSelectWorkingAgents: noop,
};

function renderHeader(overrides: Partial<WorktreeHeaderProps> = {}) {
  return render(
    <TooltipProvider>
      <WorktreeHeader
        worktree={baseWorktree}
        isActive={false}
        isMainWorktree={false}
        isPinned={false}
        branchLabel="feature/test"
        badges={{}}
        menu={baseMenu}
        {...overrides}
      />
    </TooltipProvider>
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
    expect(wrapper.className).toContain("group-hover/card:pointer-events-auto");
    expect(wrapper.className).toContain("group-hover/card:opacity-100");
    expect(wrapper.className).toContain("group-focus-within/card:pointer-events-auto");
    expect(wrapper.className).toContain("group-focus-within/card:opacity-100");
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
    expect(titleSpan!.className).toContain("text-text-secondary");
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

describe("WorktreeHeader primary worktree standard branch layout", () => {
  const mainWorktree: WorktreeState = {
    ...baseWorktree,
    isMainWorktree: true,
    name: "daintree-app",
    branch: "main",
  };

  it("renders project name as headline when isMainOnStandardBranch and no issue title", () => {
    renderHeader({
      worktree: mainWorktree,
      isMainWorktree: true,
      isMainOnStandardBranch: true,
      branchLabel: "main",
    });
    const projectName = screen.getByTestId("primary-worktree-project-name");
    expect(projectName.textContent).toBe("daintree-app");
  });

  it("renders branch label in secondary row", () => {
    renderHeader({
      worktree: mainWorktree,
      isMainWorktree: true,
      isMainOnStandardBranch: true,
      branchLabel: "main",
    });
    expect(screen.getByTestId("primary-worktree-project-name")).toBeDefined();
    expect(screen.getByText("main")).toBeDefined();
  });

  it("applies active styling to project name when isActive", () => {
    renderHeader({
      worktree: mainWorktree,
      isMainWorktree: true,
      isMainOnStandardBranch: true,
      isActive: true,
      branchLabel: "main",
    });
    const projectName = screen.getByTestId("primary-worktree-project-name");
    expect(projectName.className).toContain("text-text-primary/90");
  });

  it("applies inactive styling to project name when not active", () => {
    renderHeader({
      worktree: mainWorktree,
      isMainWorktree: true,
      isMainOnStandardBranch: true,
      isActive: false,
      branchLabel: "main",
    });
    const projectName = screen.getByTestId("primary-worktree-project-name");
    expect(projectName.className).toContain("text-text-secondary");
  });

  it("falls back to BranchLabel when isMainOnStandardBranch is false", () => {
    renderHeader({
      worktree: { ...mainWorktree, branch: "feature/test" },
      isMainWorktree: true,
      isMainOnStandardBranch: false,
      branchLabel: "feature/test",
    });
    expect(screen.queryByTestId("primary-worktree-project-name")).toBeNull();
    expect(screen.getByText(/test/)).toBeDefined();
  });

  it("uses issue title as headline even when isMainOnStandardBranch if issue exists", () => {
    renderHeader({
      worktree: { ...mainWorktree, issueNumber: 100, issueTitle: "Some issue" },
      isMainWorktree: true,
      isMainOnStandardBranch: true,
      branchLabel: "main",
    });
    expect(screen.queryByTestId("primary-worktree-project-name")).toBeNull();
    expect(screen.getByText("Some issue")).toBeDefined();
  });

  it("applies muted styling to project name when isMuted", () => {
    renderHeader({
      worktree: mainWorktree,
      isMainWorktree: true,
      isMainOnStandardBranch: true,
      isActive: false,
      isMuted: true,
      branchLabel: "main",
    });
    const projectName = screen.getByTestId("primary-worktree-project-name");
    expect(projectName.className).toContain("text-text-muted");
  });

  it("falls back to BranchLabel when isMainOnStandardBranch is undefined", () => {
    renderHeader({
      worktree: mainWorktree,
      isMainWorktree: true,
      branchLabel: "main",
    });
    expect(screen.queryByTestId("primary-worktree-project-name")).toBeNull();
  });

  it("hides secondary branch row when collapsed", () => {
    renderHeader({
      worktree: mainWorktree,
      isMainWorktree: true,
      isMainOnStandardBranch: true,
      isCollapsed: true,
      branchLabel: "main",
    });
    expect(screen.getByTestId("primary-worktree-project-name")).toBeDefined();
    // The branch "main" should only appear as the project name row, not a separate secondary element
    const allText = screen.getByTestId("primary-worktree-project-name").textContent;
    expect(allText).toBe("daintree-app");
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

  it("calls onOpenPlan when plan badge is clicked on active card", async () => {
    const onOpenPlan = vi.fn();
    renderHeader({
      worktree: { ...baseWorktree, hasPlanFile: true, planFilePath: "TASKS.md" },
      badges: { onOpenPlan },
      isActive: true,
    });

    const planButton = screen.getByRole("button", { name: /View agent plan file/ });
    planButton.click();
    expect(onOpenPlan).toHaveBeenCalledOnce();
  });

  it("does not call onOpenPlan when plan badge is clicked on inactive card", async () => {
    const onOpenPlan = vi.fn();
    renderHeader({
      worktree: { ...baseWorktree, hasPlanFile: true, planFilePath: "TASKS.md" },
      badges: { onOpenPlan },
      isActive: false,
    });

    const planButton = screen.getByRole("button", { name: /View agent plan file/ });
    planButton.click();
    expect(onOpenPlan).not.toHaveBeenCalled();
  });
});

describe("WorktreeHeader click bubbling", () => {
  function renderHeaderInWrapper(overrides: Partial<WorktreeHeaderProps> = {}) {
    const onParentClick = vi.fn();
    const result = render(
      <TooltipProvider>
        <div onClick={onParentClick} data-testid="parent-wrapper">
          <WorktreeHeader
            worktree={baseWorktree}
            isActive={false}
            isMainWorktree={false}
            isPinned={false}
            branchLabel="feature/test"
            badges={{}}
            menu={baseMenu}
            {...overrides}
          />
        </div>
      </TooltipProvider>
    );
    return { ...result, onParentClick };
  }

  it("issue badge click on inactive card bubbles to parent but does NOT call onOpenIssue", () => {
    const onOpenIssue = vi.fn();
    const { onParentClick } = renderHeaderInWrapper({
      worktree: { ...baseWorktree, issueNumber: 42, issueTitle: "Test issue" },
      badges: { onOpenIssue },
      isActive: false,
    });

    const issueButton = screen.getByRole("button", { name: /Open issue #42/ });
    fireEvent.click(issueButton);
    expect(onOpenIssue).not.toHaveBeenCalled();
    expect(onParentClick).toHaveBeenCalledOnce();
  });

  it("issue badge click on active card calls onOpenIssue and bubbles to parent", () => {
    const onOpenIssue = vi.fn();
    const { onParentClick } = renderHeaderInWrapper({
      worktree: { ...baseWorktree, issueNumber: 42, issueTitle: "Test issue" },
      badges: { onOpenIssue },
      isActive: true,
    });

    const issueButton = screen.getByRole("button", { name: /Open issue #42/ });
    fireEvent.click(issueButton);
    expect(onOpenIssue).toHaveBeenCalledOnce();
    expect(onParentClick).toHaveBeenCalledOnce();
  });

  it("PR badge click on inactive card bubbles to parent but does NOT call onOpenPR", () => {
    const onOpenPR = vi.fn();
    const { onParentClick } = renderHeaderInWrapper({
      worktree: { ...baseWorktree, prNumber: 101, prState: "open" },
      badges: { onOpenPR },
      isActive: false,
    });

    const prButton = screen.getByRole("button", { name: /pull request #101/ });
    fireEvent.click(prButton);
    expect(onOpenPR).not.toHaveBeenCalled();
    expect(onParentClick).toHaveBeenCalledOnce();
  });

  it("PR badge click on active card calls onOpenPR and bubbles to parent", () => {
    const onOpenPR = vi.fn();
    const { onParentClick } = renderHeaderInWrapper({
      worktree: { ...baseWorktree, prNumber: 101, prState: "open" },
      badges: { onOpenPR },
      isActive: true,
    });

    const prButton = screen.getByRole("button", { name: /pull request #101/ });
    fireEvent.click(prButton);
    expect(onOpenPR).toHaveBeenCalledOnce();
    expect(onParentClick).toHaveBeenCalledOnce();
  });

  it("plan badge click on inactive card bubbles to parent but does NOT call onOpenPlan", () => {
    const onOpenPlan = vi.fn();
    const { onParentClick } = renderHeaderInWrapper({
      worktree: { ...baseWorktree, hasPlanFile: true, planFilePath: "TODO.md" },
      badges: { onOpenPlan },
      isActive: false,
    });

    const planButton = screen.getByRole("button", { name: /View agent plan file/ });
    fireEvent.click(planButton);
    expect(onOpenPlan).not.toHaveBeenCalled();
    expect(onParentClick).toHaveBeenCalledOnce();
  });

  it("plan badge click on active card calls onOpenPlan and bubbles to parent", () => {
    const onOpenPlan = vi.fn();
    const { onParentClick } = renderHeaderInWrapper({
      worktree: { ...baseWorktree, hasPlanFile: true, planFilePath: "TODO.md" },
      badges: { onOpenPlan },
      isActive: true,
    });

    const planButton = screen.getByRole("button", { name: /View agent plan file/ });
    fireEvent.click(planButton);
    expect(onOpenPlan).toHaveBeenCalledOnce();
    expect(onParentClick).toHaveBeenCalledOnce();
  });

  it("inactive badges have aria-disabled attribute", () => {
    renderHeaderInWrapper({
      worktree: {
        ...baseWorktree,
        issueNumber: 42,
        issueTitle: "Test issue",
        prNumber: 101,
        prState: "open",
        hasPlanFile: true,
        planFilePath: "TODO.md",
      },
      badges: { onOpenIssue: vi.fn(), onOpenPR: vi.fn(), onOpenPlan: vi.fn() },
      isActive: false,
    });

    const issueButton = screen.getByRole("button", { name: /Open issue #42/ });
    const prButton = screen.getByRole("button", { name: /pull request #101/ });
    const planButton = screen.getByRole("button", { name: /View agent plan file/ });
    expect(issueButton.getAttribute("aria-disabled")).toBe("true");
    expect(prButton.getAttribute("aria-disabled")).toBe("true");
    expect(planButton.getAttribute("aria-disabled")).toBe("true");
  });

  it("active badges do not have aria-disabled attribute", () => {
    renderHeaderInWrapper({
      worktree: {
        ...baseWorktree,
        issueNumber: 42,
        issueTitle: "Test issue",
        prNumber: 101,
        prState: "open",
        hasPlanFile: true,
        planFilePath: "TODO.md",
      },
      badges: { onOpenIssue: vi.fn(), onOpenPR: vi.fn(), onOpenPlan: vi.fn() },
      isActive: true,
    });

    const issueButton = screen.getByRole("button", { name: /Open issue #42/ });
    const prButton = screen.getByRole("button", { name: /pull request #101/ });
    const planButton = screen.getByRole("button", { name: /View agent plan file/ });
    expect(issueButton.getAttribute("aria-disabled")).toBeNull();
    expect(prButton.getAttribute("aria-disabled")).toBeNull();
    expect(planButton.getAttribute("aria-disabled")).toBeNull();
  });

  it("more actions button click does NOT bubble to parent", () => {
    const { onParentClick } = renderHeaderInWrapper();

    const menuButton = screen.getByTestId("worktree-actions-menu");
    fireEvent.click(menuButton);
    expect(onParentClick).not.toHaveBeenCalled();
  });

  it("collapse button click does NOT bubble to parent", () => {
    const onToggleCollapse = vi.fn((e: React.MouseEvent) => e.stopPropagation());
    const { onParentClick } = renderHeaderInWrapper({
      canCollapse: true,
      onToggleCollapse,
    });

    const collapseButton = screen.getByRole("button", { name: /Collapse card/ });
    fireEvent.click(collapseButton);
    expect(onToggleCollapse).toHaveBeenCalledOnce();
    expect(onParentClick).not.toHaveBeenCalled();
  });
});

describe("WorktreeHeader decorative elements", () => {
  it("Sprout icon has pointer-events-none when isMainWorktree", () => {
    const { container } = renderHeader({ isMainWorktree: true });
    const sprout = container.querySelector('svg[aria-hidden="true"]');
    expect(sprout).toBeDefined();
    expect(sprout!.getAttribute("class")).toContain("pointer-events-none");
  });

  it("Pin icon has pointer-events-none when isPinned", () => {
    const { container } = renderHeader({ isPinned: true });
    const pin = container.querySelector('svg[aria-label="Pinned"]');
    expect(pin).toBeDefined();
    expect(pin!.getAttribute("class")).toContain("pointer-events-none");
  });

  it("(detached) span has pointer-events-none", () => {
    renderHeader({
      worktree: { ...baseWorktree, isDetached: true },
    });
    const detached = screen.getByText("(detached)");
    expect(detached.className).toContain("pointer-events-none");
  });
});

describe("WorktreeHeader hover:underline on badges", () => {
  const issueWt = { ...baseWorktree, issueNumber: 42, issueTitle: "Test issue" };
  const prWt = { ...baseWorktree, prNumber: 101, prState: "open" as const };
  const planWt = { ...baseWorktree, hasPlanFile: true, planFilePath: "TODO.md" };

  function getIssueSpan(container: HTMLElement) {
    return container.querySelector('button[aria-label*="Open issue"] .truncate');
  }

  it("sidebar variant: issue badge underline only when active", () => {
    const { container } = renderHeader({ worktree: issueWt, badges: { onOpenIssue: noop } });
    expect(getIssueSpan(container)!.className).not.toContain("hover:underline");

    const { container: activeContainer } = renderHeader({
      worktree: issueWt,
      badges: { onOpenIssue: noop },
      isActive: true,
    });
    expect(getIssueSpan(activeContainer)!.className).toContain("hover:underline");
  });

  it("sidebar variant: PR badge underline only when active", () => {
    const { unmount } = renderHeader({ worktree: prWt, badges: { onOpenPR: noop } });
    expect(screen.getByText("#101").className).not.toContain("hover:underline");
    unmount();

    renderHeader({ worktree: prWt, badges: { onOpenPR: noop }, isActive: true });
    expect(screen.getByText("#101").className).toContain("hover:underline");
  });

  it("sidebar variant: plan badge underline only when active", () => {
    const { unmount } = renderHeader({ worktree: planWt, badges: { onOpenPlan: noop } });
    expect(screen.getByText("TODO.md").className).not.toContain("hover:underline");
    unmount();

    renderHeader({ worktree: planWt, badges: { onOpenPlan: noop }, isActive: true });
    expect(screen.getByText("TODO.md").className).toContain("hover:underline");
  });

  it("grid variant: badges keep hover:underline regardless of active state", () => {
    const { container, unmount } = renderHeader({
      worktree: {
        ...issueWt,
        prNumber: 101,
        prState: "open",
        hasPlanFile: true,
        planFilePath: "TODO.md",
      },
      badges: { onOpenIssue: noop, onOpenPR: noop, onOpenPlan: noop },
      variant: "grid",
    });
    expect(getIssueSpan(container)!.className).toContain("hover:underline");
    expect(screen.getByText("#101").className).toContain("hover:underline");
    expect(screen.getByText("TODO.md").className).toContain("hover:underline");
    unmount();

    const { container: activeContainer } = renderHeader({
      worktree: {
        ...issueWt,
        prNumber: 101,
        prState: "open",
        hasPlanFile: true,
        planFilePath: "TODO.md",
      },
      badges: { onOpenIssue: noop, onOpenPR: noop, onOpenPlan: noop },
      variant: "grid",
      isActive: true,
    });
    expect(getIssueSpan(activeContainer)!.className).toContain("hover:underline");
  });
});

const allZeroStates = {
  working: 0,
  running: 0,
  waiting: 0,
  directing: 0,
  idle: 0,
  completed: 0,
  exited: 0,
} as const;

describe("WorktreeHeader collapsed session indicators", () => {
  it("renders session indicators when collapsed with sessions", () => {
    renderHeader({
      isCollapsed: true,
      sessionTotal: 3,
      sessionStates: { ...allZeroStates, working: 2, waiting: 1 },
    });
    const container = screen.getByTestId("collapsed-session-indicators");
    expect(container).toBeDefined();
    expect(container.getAttribute("aria-label")).toBe("3 sessions: 2 working, 1 waiting");
  });

  it("does not render session indicators when sessionTotal is 0", () => {
    renderHeader({
      isCollapsed: true,
      sessionTotal: 0,
      sessionStates: allZeroStates,
    });
    expect(screen.queryByTestId("collapsed-session-indicators")).toBeNull();
  });

  it("does not render session indicators when not collapsed", () => {
    renderHeader({
      isCollapsed: false,
      sessionTotal: 3,
      sessionStates: { ...allZeroStates, working: 2, waiting: 1 },
    });
    expect(screen.queryByTestId("collapsed-session-indicators")).toBeNull();
  });

  it("excludes idle state from indicators", () => {
    renderHeader({
      isCollapsed: true,
      sessionTotal: 3,
      sessionStates: { ...allZeroStates, idle: 2, working: 1 },
    });
    const container = screen.getByTestId("collapsed-session-indicators");
    const badges = container.querySelectorAll("[aria-hidden='true']");
    expect(badges.length).toBe(1);
    expect(container.getAttribute("aria-label")).toBe("3 sessions: 1 working");
  });

  it("applies aria-label with state breakdown", () => {
    renderHeader({
      isCollapsed: true,
      sessionTotal: 5,
      sessionStates: { ...allZeroStates, working: 2, completed: 3 },
    });
    const container = screen.getByTestId("collapsed-session-indicators");
    expect(container.getAttribute("aria-label")).toBe("5 sessions: 2 working, 3 done");
  });

  it("orders states by STATE_PRIORITY (working before waiting)", () => {
    renderHeader({
      isCollapsed: true,
      sessionTotal: 3,
      sessionStates: { ...allZeroStates, waiting: 1, working: 2 },
    });
    const indicators = screen.getByTestId("collapsed-session-indicators");
    const badges = indicators.querySelectorAll("[aria-hidden='true']");
    expect(badges.length).toBe(2);
    // First badge should be working (text-state-working), second waiting (text-state-waiting)
    expect(badges[0]!.className).toContain("text-state-working");
    expect(badges[1]!.className).toContain("text-state-waiting");
  });

  it("applies animate-spin-slow only to working icon", () => {
    renderHeader({
      isCollapsed: true,
      sessionTotal: 3,
      sessionStates: { ...allZeroStates, working: 2, completed: 1 },
    });
    const indicators = screen.getByTestId("collapsed-session-indicators");
    const svgs = indicators.querySelectorAll("svg");
    // First svg is working icon — should have animate-spin-slow
    expect(svgs[0]!.getAttribute("class")).toContain("animate-spin-slow");
    // Second svg is completed icon — should NOT have animate-spin-slow
    expect(svgs[1]!.getAttribute("class")).not.toContain("animate-spin-slow");
  });

  it("does not render when sessionStates is not provided", () => {
    renderHeader({ isCollapsed: true });
    expect(screen.queryByTestId("collapsed-session-indicators")).toBeNull();
  });

  it("uses singular 'session' when sessionTotal is 1", () => {
    renderHeader({
      isCollapsed: true,
      sessionTotal: 1,
      sessionStates: { ...allZeroStates, working: 1 },
    });
    const container = screen.getByTestId("collapsed-session-indicators");
    expect(container.getAttribute("aria-label")).toBe("1 session: 1 working");
  });

  it("does not render when all sessions are idle", () => {
    renderHeader({
      isCollapsed: true,
      sessionTotal: 3,
      sessionStates: { ...allZeroStates, idle: 3 },
    });
    expect(screen.queryByTestId("collapsed-session-indicators")).toBeNull();
  });
});

describe("WorktreeHeader cleanup button", () => {
  it("renders the cleanup button when onCleanupWorktree is provided", () => {
    renderHeader({ onCleanupWorktree: vi.fn() });
    const button = screen.getByRole("button", { name: "Delete worktree" });
    expect(button).toBeDefined();
    expect(button.getAttribute("data-testid")).toBe("worktree-cleanup-button");
  });

  it("does not render the cleanup button when onCleanupWorktree is omitted", () => {
    renderHeader();
    expect(screen.queryByRole("button", { name: "Delete worktree" })).toBeNull();
    expect(screen.queryByTestId("worktree-cleanup-button")).toBeNull();
  });

  it("places the cleanup button inside the hover-gated actions wrapper", () => {
    renderHeader({ onCleanupWorktree: vi.fn() });
    const button = screen.getByTestId("worktree-cleanup-button");
    const wrapper = screen.getByTestId("worktree-actions-wrapper");
    expect(wrapper.contains(button)).toBe(true);
  });

  it("hides the cleanup button alongside other actions on inactive, non-collapsed cards", () => {
    renderHeader({ onCleanupWorktree: vi.fn(), isActive: false, isCollapsed: false });
    const button = screen.getByTestId("worktree-cleanup-button");
    const wrapper = screen.getByTestId("worktree-actions-wrapper");
    // The hover-gated wrapper hides on inactive cards and reveals on group hover/focus.
    expect(wrapper.className).toContain("opacity-0");
    expect(wrapper.className).toContain("pointer-events-none");
    expect(wrapper.className).toContain("group-hover/card:opacity-100");
    expect(wrapper.className).toContain("group-focus-within/card:opacity-100");
    // The cleanup button inherits visibility through the wrapper, not its own classes.
    expect(wrapper.contains(button)).toBe(true);
  });

  it("shows the cleanup button on active cards", () => {
    renderHeader({ onCleanupWorktree: vi.fn(), isActive: true, isCollapsed: false });
    const wrapper = screen.getByTestId("worktree-actions-wrapper");
    expect(wrapper.className).toContain("opacity-100");
    expect(wrapper.className).not.toContain("opacity-0");
  });

  it("shows the cleanup button on collapsed cards", () => {
    renderHeader({ onCleanupWorktree: vi.fn(), isActive: false, isCollapsed: true });
    const wrapper = screen.getByTestId("worktree-actions-wrapper");
    expect(wrapper.className).toContain("opacity-100");
    expect(wrapper.className).not.toContain("opacity-0");
  });

  it("renders the cleanup button as the first action in the wrapper", () => {
    renderHeader({
      onCleanupWorktree: vi.fn(),
      canCollapse: true,
      onToggleCollapse: noop,
    });
    const wrapper = screen.getByTestId("worktree-actions-wrapper");
    const cleanupButton = screen.getByTestId("worktree-cleanup-button");
    expect(wrapper.firstElementChild).toBe(cleanupButton);
  });

  it("uses muted destructive coloring at idle and full red on hover", () => {
    renderHeader({ onCleanupWorktree: vi.fn() });
    const button = screen.getByTestId("worktree-cleanup-button");
    expect(button.className).toContain("text-status-error/70");
    expect(button.className).toContain("hover:text-status-error");
    expect(button.className).not.toContain("text-github-merged");
  });

  it("calls onCleanupWorktree and stops propagation when clicked", () => {
    const onCleanupWorktree = vi.fn();
    const onParentClick = vi.fn();
    render(
      <TooltipProvider>
        <div onClick={onParentClick} data-testid="parent-wrapper">
          <WorktreeHeader
            worktree={baseWorktree}
            isActive={false}
            isMainWorktree={false}
            isPinned={false}
            branchLabel="feature/test"
            badges={{}}
            menu={baseMenu}
            onCleanupWorktree={onCleanupWorktree}
          />
        </div>
      </TooltipProvider>
    );

    const button = screen.getByRole("button", { name: "Delete worktree" });
    fireEvent.click(button);
    expect(onCleanupWorktree).toHaveBeenCalledOnce();
    expect(onParentClick).not.toHaveBeenCalled();
  });
});

describe("WorktreeHeader icon button hit targets", () => {
  it("collapse button has p-1.5 for WCAG 24px minimum", () => {
    renderHeader({
      canCollapse: true,
      onToggleCollapse: noop,
    });
    const collapseButton = screen.getByRole("button", { name: /Collapse card/ });
    expect(collapseButton.className).toContain("p-1.5");
  });

  it("more actions button has p-1.5 for WCAG 24px minimum", () => {
    renderHeader();
    const menuButton = screen.getByTestId("worktree-actions-menu");
    expect(menuButton.className).toContain("p-1.5");
  });
});

describe("WorktreeHeader token-missing badge behavior", () => {
  beforeEach(() => {
    mockMissingToken = false;
    vi.mocked(actionService.dispatch).mockClear();
  });

  it("issue badge shows token-missing aria-label when no token configured", () => {
    mockMissingToken = true;
    renderHeader({
      worktree: { ...baseWorktree, issueNumber: 42, issueTitle: "Test issue" },
      badges: { onOpenIssue: noop },
      isActive: true,
    });

    const issueButton = screen.getByRole("button", {
      name: /Configure GitHub token to see issue details/,
    });
    expect(issueButton).toBeDefined();
    expect(issueButton.className).toContain("opacity-60");
  });

  it("issue badge dispatches settings action on click when no token configured", () => {
    mockMissingToken = true;
    const onOpenIssue = vi.fn();
    renderHeader({
      worktree: { ...baseWorktree, issueNumber: 42, issueTitle: "Test issue" },
      badges: { onOpenIssue },
      isActive: true,
    });

    const issueButton = screen.getByRole("button", {
      name: /Configure GitHub token to see issue details/,
    });
    fireEvent.click(issueButton);
    expect(actionService.dispatch).toHaveBeenCalledWith(
      "app.settings.openTab",
      { tab: "github", sectionId: "github-token" },
      { source: "user" }
    );
    expect(onOpenIssue).not.toHaveBeenCalled();
  });

  it("PR badge shows token-missing aria-label when no token configured", () => {
    mockMissingToken = true;
    renderHeader({
      worktree: { ...baseWorktree, prNumber: 101, prState: "open" },
      badges: { onOpenPR: noop },
      isActive: true,
    });

    const prButton = screen.getByRole("button", {
      name: /Configure GitHub token to see PR details/,
    });
    expect(prButton).toBeDefined();
    expect(prButton.className).toContain("opacity-60");
  });

  it("PR badge dispatches settings action on click when no token configured", () => {
    mockMissingToken = true;
    const onOpenPR = vi.fn();
    renderHeader({
      worktree: { ...baseWorktree, prNumber: 101, prState: "open" },
      badges: { onOpenPR },
      isActive: true,
    });

    const prButton = screen.getByRole("button", {
      name: /Configure GitHub token to see PR details/,
    });
    fireEvent.click(prButton);
    expect(actionService.dispatch).toHaveBeenCalledWith(
      "app.settings.openTab",
      { tab: "github", sectionId: "github-token" },
      { source: "user" }
    );
    expect(onOpenPR).not.toHaveBeenCalled();
  });

  it("issue badge calls onOpenIssue normally when token is present", () => {
    mockMissingToken = false;
    const onOpenIssue = vi.fn();
    renderHeader({
      worktree: { ...baseWorktree, issueNumber: 42, issueTitle: "Test issue" },
      badges: { onOpenIssue },
      isActive: true,
    });

    const issueButton = screen.getByRole("button", {
      name: /Open issue #42/,
    });
    fireEvent.click(issueButton);
    expect(actionService.dispatch).not.toHaveBeenCalled();
    expect(onOpenIssue).toHaveBeenCalledOnce();
  });

  it("token-missing badge click does nothing on inactive card", () => {
    mockMissingToken = true;
    renderHeader({
      worktree: { ...baseWorktree, issueNumber: 42, issueTitle: "Test issue" },
      badges: { onOpenIssue: noop },
      isActive: false,
    });

    const issueButton = screen.getByRole("button", {
      name: /Configure GitHub token/,
    });
    fireEvent.click(issueButton);
    expect(actionService.dispatch).not.toHaveBeenCalled();
  });
});
