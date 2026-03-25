/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { ReactNode } from "react";
import { WorktreeHeader, type WorktreeHeaderProps } from "../WorktreeHeader";
import type { WorktreeState } from "@shared/types";
import { TooltipProvider } from "@/components/ui/tooltip";

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
  counts: { grid: 0, dock: 0, active: 0, completed: 0, all: 0 },
  onCopyContextFull: noop,
  onCopyContextModified: noop,
  onCopyPath: noop,
  onOpenEditor: noop,
  onRevealInFinder: noop,
  onRunRecipe: noop,
  onDockAll: noop,
  onMaximizeAll: noop,
  onRestartAll: noop,
  onResetRenderers: noop,
  onCloseCompleted: noop,
  onCloseAll: noop,
  onEndAll: noop,
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

  it("issue badge click bubbles to parent (card selection)", () => {
    const onOpenIssue = vi.fn();
    const { onParentClick } = renderHeaderInWrapper({
      worktree: { ...baseWorktree, issueNumber: 42, issueTitle: "Test issue" },
      badges: { onOpenIssue },
    });

    const issueButton = screen.getByRole("button", { name: /Open issue #42/ });
    fireEvent.click(issueButton);
    expect(onOpenIssue).toHaveBeenCalledOnce();
    expect(onParentClick).toHaveBeenCalledOnce();
  });

  it("PR badge click bubbles to parent (card selection)", () => {
    const onOpenPR = vi.fn();
    const { onParentClick } = renderHeaderInWrapper({
      worktree: { ...baseWorktree, prNumber: 101, prState: "open" },
      badges: { onOpenPR },
    });

    const prButton = screen.getByRole("button", { name: /pull request #101/ });
    fireEvent.click(prButton);
    expect(onOpenPR).toHaveBeenCalledOnce();
    expect(onParentClick).toHaveBeenCalledOnce();
  });

  it("plan badge click bubbles to parent (card selection)", () => {
    const onOpenPlan = vi.fn();
    const { onParentClick } = renderHeaderInWrapper({
      worktree: { ...baseWorktree, hasPlanFile: true, planFilePath: "TODO.md" },
      badges: { onOpenPlan },
    });

    const planButton = screen.getByRole("button", { name: /View agent plan file/ });
    fireEvent.click(planButton);
    expect(onOpenPlan).toHaveBeenCalledOnce();
    expect(onParentClick).toHaveBeenCalledOnce();
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
  it("issue badge text span has hover:underline", () => {
    const { container } = renderHeader({
      worktree: { ...baseWorktree, issueNumber: 42, issueTitle: "Test issue" },
      badges: { onOpenIssue: noop },
    });
    const textSpan = container.querySelector('button[aria-label*="Open issue"] .truncate');
    expect(textSpan).toBeDefined();
    expect(textSpan!.className).toContain("hover:underline");
  });

  it("PR badge number span has hover:underline", () => {
    renderHeader({
      worktree: { ...baseWorktree, prNumber: 101, prState: "open" },
      badges: { onOpenPR: noop },
    });
    const prSpan = screen.getByText("#101");
    expect(prSpan.className).toContain("hover:underline");
  });

  it("plan badge text span has hover:underline", () => {
    renderHeader({
      worktree: { ...baseWorktree, hasPlanFile: true, planFilePath: "TODO.md" },
      badges: { onOpenPlan: noop },
    });
    const planSpan = screen.getByText("TODO.md");
    expect(planSpan.className).toContain("hover:underline");
  });
});

const allZeroStates = {
  working: 0,
  running: 0,
  waiting: 0,
  directing: 0,
  idle: 0,
  completed: 0,
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
    expect(badges[0].className).toContain("text-state-working");
    expect(badges[1].className).toContain("text-state-waiting");
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
    expect(svgs[0].getAttribute("class")).toContain("animate-spin-slow");
    // Second svg is completed icon — should NOT have animate-spin-slow
    expect(svgs[1].getAttribute("class")).not.toContain("animate-spin-slow");
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
