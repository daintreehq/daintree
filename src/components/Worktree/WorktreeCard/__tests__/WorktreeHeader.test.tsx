/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { ReactNode } from "react";
import { WorktreeHeader, type WorktreeHeaderProps } from "../WorktreeHeader";
import type { WorktreeState } from "@shared/types";
import type { NormalizedPRState } from "@shared/types/forge";
import { TooltipProvider } from "@/components/ui/tooltip";
import { actionService } from "@/services/ActionService";

vi.mock("react-dom", async () => {
  const actual = await vi.importActual<typeof import("react-dom")>("react-dom");
  return { ...actual, createPortal: (children: ReactNode) => children };
});

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = ResizeObserverStub as typeof ResizeObserver;
  }
});

let mockMissingCredential = false;

vi.mock("@/hooks/useForgeTooltip", () => ({
  useIssueTooltip: () => ({
    data: null,
    loading: false,
    error: null,
    missingCredential: mockMissingCredential,
    providerId: "daintree.github.github",
    fetchTooltip: vi.fn(),
    reset: vi.fn(),
  }),
  usePRTooltip: () => ({
    data: null,
    loading: false,
    error: null,
    missingCredential: mockMissingCredential,
    providerId: "daintree.github.github",
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

function prLinked(num: number, state: NormalizedPRState = "open") {
  return {
    linked: {
      providerId: "daintree.github.github",
      pr: {
        ref: {
          providerId: "daintree.github.github",
          owner: "",
          repo: "",
          number: num,
          rawData: null,
        },
        state: state as NormalizedPRState,
        url: `https://github.com/test/repo/pull/${num}`,
      },
    },
  };
}

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
  onCloseAll: noop,
  onTerminateAll: noop,
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
        gitStateIndicator={null}
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
  it("starts dimmed and reveals on hover, focus, or open menu when inactive", () => {
    renderHeader({ isActive: false });
    const wrapper = getWrapper();
    expect(wrapper.className).not.toContain("pointer-events-none");
    expect(wrapper.className).not.toContain("opacity-0");
    expect(wrapper.className).toContain("opacity-50");
    expect(wrapper.className).toContain("group-hover/card:opacity-100");
    expect(wrapper.className).toContain("group-has-[:focus-visible]/card:opacity-100");
    expect(wrapper.className).toContain("group-has-[[data-state=open]]/card:opacity-100");
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

describe("WorktreeHeader PR-originated headline (#8888)", () => {
  it("shows the PR title as the primary headline when sourcePrNumber is set", () => {
    renderHeader({
      worktree: {
        ...baseWorktree,
        sourcePrNumber: 314,
        linked: {
          providerId: "github",
          pr: {
            ref: { providerId: "github", owner: "o", repo: "r", number: 314, rawData: null },
            title: "Fix flaky terminal search",
            url: "https://github.com/o/r/pull/314",
            state: "open",
          },
        },
        issueNumber: 99,
      } as WorktreeState,
      badges: { onOpenPR: noop, onOpenIssue: noop },
    });

    const prButton = screen.getByRole("button", {
      name: /Open pull request #314: Fix flaky terminal search/,
    });
    expect(prButton).toBeDefined();
    expect(screen.getByText("Fix flaky terminal search")).toBeDefined();
  });

  it("falls back to the flat prTitle when linked.pr is not yet populated", () => {
    renderHeader({
      worktree: {
        ...baseWorktree,
        sourcePrNumber: 314,
        prTitle: "Eager PR title",
      } as WorktreeState,
      badges: { onOpenPR: noop },
    });
    expect(screen.getByText("Eager PR title")).toBeDefined();
  });

  it("drops the PR headline once sourcePrNumber is cleared (branch rename)", () => {
    const { rerender } = renderHeader({
      worktree: {
        ...baseWorktree,
        sourcePrNumber: 314,
        prTitle: "Eager PR title",
      } as WorktreeState,
      badges: { onOpenPR: noop },
    });
    expect(screen.getByText("Eager PR title")).toBeDefined();

    // Simulate clearPRInfo() firing on a branch change: sourcePrNumber and the
    // flat PR fields are gone, so the headline must revert to the branch label.
    rerender(
      <TooltipProvider>
        <WorktreeHeader
          worktree={{ ...baseWorktree } as WorktreeState}
          isActive={false}
          isMainWorktree={false}
          isPinned={false}
          branchLabel="feature/test"
          badges={{}}
          gitStateIndicator={null}
          menu={baseMenu}
        />
      </TooltipProvider>
    );
    expect(screen.queryByText("Eager PR title")).toBeNull();
    expect(screen.queryByRole("button", { name: /Open pull request/ })).toBeNull();
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
        ...prLinked(101),
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
    const issueButton = screen.getByRole("button", { name: /Open issue #100/ });
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
            gitStateIndicator={null}
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
      worktree: { ...baseWorktree, ...prLinked(101), prNumber: 101, prState: "open" },
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
      worktree: { ...baseWorktree, ...prLinked(101), prNumber: 101, prState: "open" },
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
        ...prLinked(101),
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
        ...prLinked(101),
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

  it("git state badge has pointer-events-none", () => {
    renderHeader({
      gitStateIndicator: { kind: "detached", label: "detached", tone: "warning" },
    });
    const badge = screen.getByText("detached");
    expect(badge.className).toContain("pointer-events-none");
    expect(badge.className).toContain("text-status-warning");
  });
});

describe("WorktreeHeader hover:underline on badges", () => {
  const issueWt = { ...baseWorktree, issueNumber: 42, issueTitle: "Test issue" };
  const prWt = { ...baseWorktree, ...prLinked(101), prNumber: 101, prState: "open" as const };
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
        ...prLinked(101),
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
        ...prLinked(101),
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
    const badges = container.querySelectorAll(":scope > span[aria-hidden='true']");
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
    const badges = indicators.querySelectorAll(":scope > span[aria-hidden='true']");
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

  it("dims the cleanup button alongside other actions on inactive, non-collapsed cards", () => {
    renderHeader({ onCleanupWorktree: vi.fn(), isActive: false, isCollapsed: false });
    const button = screen.getByTestId("worktree-cleanup-button");
    const wrapper = screen.getByTestId("worktree-actions-wrapper");
    // The wrapper persists at reduced opacity so keyboard and touch users can reach it,
    // and reveals fully on group hover/focus or when a contained menu opens.
    expect(wrapper.className).toContain("opacity-50");
    expect(wrapper.className).not.toContain("pointer-events-none");
    expect(wrapper.className).toContain("group-hover/card:opacity-100");
    expect(wrapper.className).toContain("group-has-[:focus-visible]/card:opacity-100");
    expect(wrapper.className).toContain("group-has-[[data-state=open]]/card:opacity-100");
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
    expect(button.className).not.toContain("text-pr-merged");
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
            gitStateIndicator={null}
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

function ciFailureLinked(num: number) {
  return {
    linked: {
      providerId: "daintree.github.github",
      pr: {
        ref: {
          providerId: "daintree.github.github",
          owner: "",
          repo: "",
          number: num,
          rawData: null,
        },
        state: "open" as NormalizedPRState,
        url: `https://github.com/test/repo/pull/${num}`,
        ciStatus: {
          state: "failure" as const,
          total: 1,
          passed: 0,
          failed: 1,
          pending: 0,
          rawData: null,
        },
      },
    },
  };
}

describe("WorktreeHeader collapsed alarm pill", () => {
  it("renders the pill with CI-failed treatment when collapsed and CI failed", () => {
    renderHeader({
      isCollapsed: true,
      worktree: { ...baseWorktree, ...ciFailureLinked(101) },
    });
    const pill = screen.getByTestId("collapsed-alarm-pill");
    expect(pill.getAttribute("data-alarm-kind")).toBe("ci-failed");
    expect(pill.className).toContain("text-status-error");
    expect(pill.textContent).toBe("CI failed");
  });

  it("renders the pill with warning treatment for GitHub auth-failed remote", () => {
    renderHeader({
      isCollapsed: true,
      worktree: {
        ...baseWorktree,
        fetchAuthFailed: true,
        matchedForgeProviderId: "daintree.github.github",
      },
    });
    const pill = screen.getByTestId("collapsed-alarm-pill");
    expect(pill.getAttribute("data-alarm-kind")).toBe("auth-failed");
    expect(pill.className).toContain("text-status-warning");
  });

  it("suppresses the auth-failed pill for non-GitHub remotes (matches expanded gating)", () => {
    renderHeader({
      isCollapsed: true,
      worktree: {
        ...baseWorktree,
        fetchAuthFailed: true,
        matchedForgeProviderId: null,
      },
    });
    expect(screen.queryByTestId("collapsed-alarm-pill")).toBeNull();
  });

  it("renders the pill with warning treatment for behindCount > 0", () => {
    renderHeader({
      isCollapsed: true,
      worktree: { ...baseWorktree, behindCount: 3 },
    });
    const pill = screen.getByTestId("collapsed-alarm-pill");
    expect(pill.getAttribute("data-alarm-kind")).toBe("behind");
    expect(pill.className).toContain("text-status-warning");
  });

  it("does not duplicate gitStateIndicator for detached HEAD", () => {
    // gitStateIndicator already labels detached in the title row;
    // computeAlarmTier deliberately excludes detached so collapsed rows
    // don't end up with two side-by-side "detached"/"Detached" labels.
    renderHeader({
      isCollapsed: true,
      worktree: { ...baseWorktree, isDetached: true },
      gitStateIndicator: { kind: "detached", label: "detached", tone: "warning" },
    });
    expect(screen.queryByTestId("collapsed-alarm-pill")).toBeNull();
    expect(screen.getByText("detached")).toBeDefined();
  });

  it("does not render when collapsed but no alarm fires", () => {
    renderHeader({ isCollapsed: true });
    expect(screen.queryByTestId("collapsed-alarm-pill")).toBeNull();
  });

  it("does not render when expanded — even with a CI failure", () => {
    renderHeader({
      isCollapsed: false,
      worktree: { ...baseWorktree, ...ciFailureLinked(101) },
    });
    expect(screen.queryByTestId("collapsed-alarm-pill")).toBeNull();
  });

  it("does not fire a stale CI-failed alarm when the linked PR is closed", () => {
    const closed = ciFailureLinked(101);
    closed.linked.pr.state = "closed";
    renderHeader({ isCollapsed: true, worktree: { ...baseWorktree, ...closed } });
    expect(screen.queryByTestId("collapsed-alarm-pill")).toBeNull();
  });

  it("does not fire a stale CI-failed alarm when the linked PR is declined", () => {
    const declined = ciFailureLinked(101);
    declined.linked.pr.state = "declined";
    renderHeader({ isCollapsed: true, worktree: { ...baseWorktree, ...declined } });
    expect(screen.queryByTestId("collapsed-alarm-pill")).toBeNull();
  });

  it("caps to exactly one pill when multiple alarms fire (CI wins over auth)", () => {
    const { container } = renderHeader({
      isCollapsed: true,
      worktree: {
        ...baseWorktree,
        fetchAuthFailed: true,
        matchedForgeProviderId: "daintree.github.github",
        behindCount: 5,
        ...ciFailureLinked(101),
      },
    });
    const pills = container.querySelectorAll("[data-testid='collapsed-alarm-pill']");
    expect(pills.length).toBe(1);
    expect(pills[0]!.getAttribute("data-alarm-kind")).toBe("ci-failed");
  });

  it("renders for main worktree rows too (collapsed + behind)", () => {
    renderHeader({
      isCollapsed: true,
      isMainWorktree: true,
      isMainOnStandardBranch: true,
      worktree: { ...baseWorktree, isMainWorktree: true, behindCount: 2 },
    });
    expect(screen.getByTestId("collapsed-alarm-pill").getAttribute("data-alarm-kind")).toBe(
      "behind"
    );
  });
});

const mockRetryAuthFetch = vi.fn().mockResolvedValue(undefined);

describe("WorktreeHeader token-missing badge behavior", () => {
  beforeEach(() => {
    mockMissingCredential = false;
    vi.mocked(actionService.dispatch).mockClear();
  });

  it("issue badge shows token-missing aria-label when no token configured", () => {
    mockMissingCredential = true;
    renderHeader({
      worktree: { ...baseWorktree, issueNumber: 42, issueTitle: "Test issue" },
      badges: { onOpenIssue: noop },
      isActive: true,
    });

    const issueButton = screen.getByRole("button", {
      name: /Add a forge access token to see issue details/,
    });
    expect(issueButton).toBeDefined();
    // Button stays full-opacity for focus-ring contrast; the icon is muted with a
    // solid token (not its active state color, and not opacity/grayscale dimming).
    expect(issueButton.className).not.toContain("opacity-60");
    const issueIcon = issueButton.querySelector("svg");
    expect(issueIcon?.className.baseVal).toContain("text-text-muted");
    expect(issueIcon?.className.baseVal).not.toContain("text-pr-open");
    expect(issueIcon?.className.baseVal).not.toContain("grayscale");
    expect(issueIcon?.className.baseVal).not.toContain("opacity-50");
  });

  it("issue badge dispatches settings action on click when no token configured", () => {
    mockMissingCredential = true;
    const onOpenIssue = vi.fn();
    renderHeader({
      worktree: { ...baseWorktree, issueNumber: 42, issueTitle: "Test issue" },
      badges: { onOpenIssue },
      isActive: true,
    });

    const issueButton = screen.getByRole("button", {
      name: /Add a forge access token to see issue details/,
    });
    fireEvent.click(issueButton);
    expect(actionService.dispatch).toHaveBeenCalledWith(
      "app.settings.openTab",
      { tab: "code-forge", subtab: "daintree.github.github" },
      { source: "user" }
    );
    expect(onOpenIssue).not.toHaveBeenCalled();
  });

  it("PR badge shows token-missing aria-label when no token configured", () => {
    mockMissingCredential = true;
    renderHeader({
      worktree: { ...baseWorktree, ...prLinked(101), prNumber: 101, prState: "open" },
      badges: { onOpenPR: noop },
      isActive: true,
    });

    const prButton = screen.getByRole("button", {
      name: /Add a forge access token to see PR details/,
    });
    expect(prButton).toBeDefined();
    expect(prButton.className).not.toContain("opacity-60");
    const prIcon = prButton.querySelector("svg");
    // Muted with a solid token, not the active PR-state color or opacity/grayscale.
    expect(prIcon?.className.baseVal).toContain("text-text-muted");
    expect(prIcon?.className.baseVal).not.toContain("text-pr-open");
    expect(prIcon?.className.baseVal).not.toContain("grayscale");
    expect(prIcon?.className.baseVal).not.toContain("opacity-50");
  });

  it("PR badge dispatches settings action on click when no token configured", () => {
    mockMissingCredential = true;
    const onOpenPR = vi.fn();
    renderHeader({
      worktree: { ...baseWorktree, ...prLinked(101), prNumber: 101, prState: "open" },
      badges: { onOpenPR },
      isActive: true,
    });

    const prButton = screen.getByRole("button", {
      name: /Add a forge access token to see PR details/,
    });
    fireEvent.click(prButton);
    expect(actionService.dispatch).toHaveBeenCalledWith(
      "app.settings.openTab",
      { tab: "code-forge", subtab: "daintree.github.github" },
      { source: "user" }
    );
    expect(onOpenPR).not.toHaveBeenCalled();
  });

  it("issue badge calls onOpenIssue normally when token is present", () => {
    mockMissingCredential = false;
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
    mockMissingCredential = true;
    renderHeader({
      worktree: { ...baseWorktree, issueNumber: 42, issueTitle: "Test issue" },
      badges: { onOpenIssue: noop },
      isActive: false,
    });

    const issueButton = screen.getByRole("button", {
      name: /Add a forge access token/,
    });
    fireEvent.click(issueButton);
    expect(actionService.dispatch).not.toHaveBeenCalled();
  });
});

describe("WorktreeHeader upstream sync indicator", () => {
  beforeEach(() => {
    mockMissingCredential = false;
    vi.clearAllMocks();
    // The auth-failed sync badge calls window.electron.worktree.retryAuthFetch();
    // stub just that path so the click handler doesn't throw on the bare global.
    vi.stubGlobal("electron", { worktree: { retryAuthFetch: mockRetryAuthFetch } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows ahead/behind counts and renders the indicator", () => {
    renderHeader({
      worktree: { ...baseWorktree, aheadCount: 3, behindCount: 1 },
    });
    const indicator = screen.getByTestId("upstream-sync-indicator");
    expect(indicator).toBeDefined();
    expect(indicator.textContent).toContain("↑3");
    expect(indicator.textContent).toContain("↓1");
  });

  it("does not flash on initial render", () => {
    renderHeader({
      worktree: { ...baseWorktree, aheadCount: 2, behindCount: 0 },
    });
    const indicator = screen.getByTestId("upstream-sync-indicator");
    expect(indicator.className).not.toContain("animate-upstream-badge-flash");
    expect(indicator.className).not.toContain("animate-pulse-immediate");
  });

  it("does not flash when fetch is in-flight without count change", () => {
    renderHeader({
      worktree: {
        ...baseWorktree,
        aheadCount: 2,
        behindCount: 0,
        isFetchInFlight: true,
      },
    });
    const indicator = screen.getByTestId("upstream-sync-indicator");
    expect(indicator.getAttribute("data-fetch-in-flight")).toBe("true");
    expect(indicator.className).not.toContain("animate-upstream-badge-flash");
    expect(indicator.className).not.toContain("animate-pulse-immediate");
  });

  it("does not pulse when no fetch is in-flight", () => {
    renderHeader({
      worktree: { ...baseWorktree, aheadCount: 2, behindCount: 0 },
    });
    const indicator = screen.getByTestId("upstream-sync-indicator");
    expect(indicator.className).not.toContain("animate-pulse-immediate");
  });

  it("renders dimmed chip when auth-failed and github remote", () => {
    renderHeader({
      worktree: {
        ...baseWorktree,
        aheadCount: 1,
        behindCount: 2,
        fetchAuthFailed: true,
        matchedForgeProviderId: "daintree.github.github",
        linked: { providerId: "daintree.github.github" },
      },
    });
    const indicator = screen.getByTestId("upstream-sync-indicator");
    expect(indicator).toBeDefined();
    expect(indicator.getAttribute("data-fetch-auth-failed")).toBe("true");
    // Chip shows counts in dimmed form, not a colored "Sign in" CTA.
    expect(indicator.textContent).toContain("↑1");
    expect(indicator.textContent).toContain("↓2");
    expect(indicator.textContent).not.toContain("Sign in");
    // No animate-pulse-immediate in auth-failed state.
    expect(indicator.className).not.toContain("animate-pulse-immediate");
  });

  it("renders dimmed placeholder when auth-failed and no counts", () => {
    renderHeader({
      worktree: {
        ...baseWorktree,
        aheadCount: 0,
        behindCount: 0,
        fetchAuthFailed: true,
        matchedForgeProviderId: "daintree.github.github",
        linked: { providerId: "daintree.github.github" },
      },
    });
    const indicator = screen.getByTestId("upstream-sync-indicator");
    expect(indicator).toBeDefined();
    expect(indicator.getAttribute("data-fetch-auth-failed")).toBe("true");
    expect(indicator.textContent).toContain("—");
  });

  it("renders the sign-in affordance when matchedForgeProviderId is set and no linked data (#9982)", () => {
    // Reproduces the exact bug path: fetchAuthFailed + matchedForgeProviderId but no
    // linked data (e.g. the main worktree on develop, or a token-expired
    // worktree). The header's union predicate must still raise the alarm tier
    // and the badge must still render the sign-in branch — the badge used to
    // fall through to null because it only checked the linked-only providerId.
    renderHeader({
      worktree: {
        ...baseWorktree,
        aheadCount: 0,
        behindCount: 0,
        fetchAuthFailed: true,
        matchedForgeProviderId: "daintree.github.github",
      },
    });
    const indicator = screen.getByRole("button", { name: /Forge authentication failed/ });
    expect(indicator.getAttribute("data-fetch-auth-failed")).toBe("true");
    expect(indicator.textContent).toContain("—");
    // Recovery path must be reachable on the no-linked-data path too — the
    // badge owns the only per-worktree way out of the auth-suspended fetch.
    fireEvent.click(indicator);
    expect(mockRetryAuthFetch).toHaveBeenCalledTimes(1);
    expect(actionService.dispatch).toHaveBeenCalledWith(
      "app.settings.openTab",
      { tab: "code-forge", subtab: "daintree.github.github" },
      { source: "user" }
    );
  });

  it("falls through to regular count display for non-GitHub auth failures", () => {
    renderHeader({
      worktree: {
        ...baseWorktree,
        aheadCount: 1,
        fetchAuthFailed: true,
        matchedForgeProviderId: null,
      },
    });
    const indicator = screen.getByTestId("upstream-sync-indicator");
    expect(indicator).toBeDefined();
    expect(indicator.getAttribute("data-fetch-auth-failed")).toBeNull();
    expect(indicator.getAttribute("data-fetch-in-flight")).toBeNull();
  });

  it("hides the indicator entirely when there are no counts and no auth failure", () => {
    renderHeader({
      worktree: { ...baseWorktree, aheadCount: 0, behindCount: 0 },
    });
    expect(screen.queryByTestId("upstream-sync-indicator")).toBeNull();
  });

  it("dispatches openTab → github settings on auth-failed chip click", () => {
    renderHeader({
      worktree: {
        ...baseWorktree,
        aheadCount: 1,
        fetchAuthFailed: true,
        matchedForgeProviderId: "daintree.github.github",
        linked: { providerId: "daintree.github.github" },
      },
    });
    const indicator = screen.getByTestId("upstream-sync-indicator");
    fireEvent.click(indicator);
    // Must retry the suspended fetch (the actual bug fix), not just open settings —
    // without this the stripe stays stuck forever (#9736).
    expect(mockRetryAuthFetch).toHaveBeenCalledTimes(1);
    expect(actionService.dispatch).toHaveBeenCalledWith(
      "app.settings.openTab",
      { tab: "code-forge", subtab: "daintree.github.github" },
      { source: "user" }
    );
  });

  it("renders the count display when only fetchNetworkFailed is set", () => {
    renderHeader({
      worktree: {
        ...baseWorktree,
        aheadCount: 1,
        fetchNetworkFailed: true,
      },
    });
    // The badge still renders the count display (transient failure doesn't
    // replace the indicator like the auth+github path does), but it carries a
    // partial dim so the failed row is distinguishable from a healthy one at
    // the row level — without grayscale, which is reserved for the persistent
    // auth-failure treatment.
    const indicator = screen.getByTestId("upstream-sync-indicator");
    expect(indicator).toBeDefined();
    expect(indicator.textContent).toContain("↑1");
    expect(indicator.className).toContain("opacity-75");
    expect(indicator.className).not.toContain("grayscale");
    expect(indicator.className).not.toContain("opacity-50");
    expect(indicator.getAttribute("data-fetch-network-failed")).toBe("true");
  });

  it("does not dim the count display on a healthy worktree", () => {
    renderHeader({
      worktree: { ...baseWorktree, aheadCount: 1 },
    });
    const indicator = screen.getByTestId("upstream-sync-indicator");
    expect(indicator).toBeDefined();
    expect(indicator.className).not.toContain("opacity-75");
    expect(indicator.getAttribute("data-fetch-network-failed")).toBeNull();
  });

  it("prefers the auth-failed treatment over the network-failed dim", () => {
    // Mutually exclusive at source (RepoFetchCoordinator), but pin the
    // precedence so a regression can't surface both treatments at once.
    renderHeader({
      worktree: {
        ...baseWorktree,
        aheadCount: 1,
        fetchAuthFailed: true,
        fetchNetworkFailed: true,
        matchedForgeProviderId: "daintree.github.github",
        linked: { providerId: "daintree.github.github" },
      },
    });
    const indicator = screen.getByTestId("upstream-sync-indicator");
    expect(indicator.getAttribute("data-fetch-auth-failed")).toBe("true");
    expect(indicator.getAttribute("data-fetch-network-failed")).toBeNull();
    expect(indicator.className).not.toContain("opacity-75");
  });
});

describe("WorktreeHeader blocking-op recovery row (#10715)", () => {
  // The row mounts off worktree.repoState (the raw in-progress operation), NOT
  // gitStateIndicator — so it surfaces even when conflicts make the badge read
  // "conflicted". gitStateIndicator only drives the inert badge label.
  function conflictedChanges(): WorktreeState["worktreeChanges"] {
    return {
      worktreeId: "test-wt",
      rootPath: "/tmp/test-wt",
      changedFileCount: 1,
      changes: [{ path: "a.ts", status: "conflicted", insertions: null, deletions: null }],
    };
  }

  function blockingHeader(
    repoState: WorktreeState["repoState"],
    overrides: Partial<WorktreeHeaderProps> = {}
  ) {
    const { worktree: worktreeOverride, ...rest } = overrides;
    return renderHeader({
      worktree: { ...baseWorktree, repoState, ...(worktreeOverride ?? {}) },
      onAbortRepositoryOperation: vi.fn().mockResolvedValue(undefined),
      onContinueRepositoryOperation: vi.fn().mockResolvedValue(undefined),
      ...rest,
    });
  }

  const BLOCKING = [
    { repoState: "REVERTING", label: "revert" },
    { repoState: "REBASING", label: "rebase" },
    { repoState: "MERGING", label: "merge" },
    { repoState: "CHERRY_PICKING", label: "cherry-pick" },
  ] as const;

  it.each(BLOCKING)("renders Continue + Abort for $repoState", ({ repoState, label }) => {
    blockingHeader(repoState);
    expect(screen.getByRole("button", { name: `Continue ${label}` })).toBeTruthy();
    expect(screen.getByRole("button", { name: `Abort ${label}` })).toBeTruthy();
  });

  it("renders the row for an in-progress operation that has conflicts (the canonical stuck case)", () => {
    blockingHeader("REVERTING", { worktree: { worktreeChanges: conflictedChanges() } });
    // Row still mounts even though the badge would read "conflicted"...
    expect(screen.getByRole("button", { name: "Abort revert" })).toBeTruthy();
    // ...and Continue is disabled until the conflicts are resolved.
    const cont = screen.getByRole("button", { name: "Continue revert" });
    expect(cont.hasAttribute("disabled")).toBe(true);
  });

  it("does not render the row when no operation is in progress", () => {
    renderHeader({
      worktree: { ...baseWorktree, repoState: undefined, isDetached: true },
      onAbortRepositoryOperation: vi.fn(),
      onContinueRepositoryOperation: vi.fn(),
    });
    expect(screen.queryByRole("button", { name: /^Continue / })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Abort / })).toBeNull();
  });

  it("does not render the row when collapsed", () => {
    blockingHeader("REVERTING", { isCollapsed: true });
    expect(screen.queryByRole("button", { name: "Continue revert" })).toBeNull();
  });

  it("does not render the row when callbacks are absent", () => {
    renderHeader({ worktree: { ...baseWorktree, repoState: "REVERTING" } });
    expect(screen.queryByRole("button", { name: "Continue revert" })).toBeNull();
  });

  it("Abort opens a destructive ConfirmDialog and confirming invokes onAbort", async () => {
    const onAbort = vi.fn().mockResolvedValue(undefined);
    blockingHeader("REVERTING", { onAbortRepositoryOperation: onAbort });
    // The inline Abort button only opens the dialog — it must not call IPC directly.
    const triggers = screen.getAllByRole("button", { name: "Abort revert" });
    fireEvent.click(triggers[0]);
    expect(onAbort).not.toHaveBeenCalled();

    // The dialog's confirm button carries the same verb-noun label; it's the
    // last "Abort revert" button now that the dialog has opened.
    const confirmButtons = screen.getAllByRole("button", { name: "Abort revert" });
    const dialogConfirm = confirmButtons[confirmButtons.length - 1];
    fireEvent.click(dialogConfirm);
    await Promise.resolve();
    expect(onAbort).toHaveBeenCalledTimes(1);
  });

  it("keeps the abort dialog open when the abort fails so the user can retry", async () => {
    const onAbort = vi.fn().mockRejectedValue(new Error("nope"));
    blockingHeader("REVERTING", { onAbortRepositoryOperation: onAbort });
    fireEvent.click(screen.getAllByRole("button", { name: "Abort revert" })[0]);
    const confirmButtons = screen.getAllByRole("button", { name: "Abort revert" });
    fireEvent.click(confirmButtons[confirmButtons.length - 1]);
    await Promise.resolve();
    await Promise.resolve();
    // Dialog still mounted (both trigger + confirm present) and not stuck loading.
    expect(screen.getAllByRole("button", { name: "Abort revert" }).length).toBeGreaterThan(1);
    expect(onAbort).toHaveBeenCalledTimes(1);
  });

  it("Continue invokes onContinue when there are no unresolved conflicts", async () => {
    const onContinue = vi.fn().mockResolvedValue(undefined);
    blockingHeader("REBASING", { onContinueRepositoryOperation: onContinue });
    const btn = screen.getByRole("button", { name: "Continue rebase" });
    expect(btn.hasAttribute("disabled")).toBe(false);
    fireEvent.click(btn);
    await Promise.resolve();
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it("Continue is disabled while unresolved conflicts remain", () => {
    const onContinue = vi.fn();
    blockingHeader("REBASING", {
      worktree: { worktreeChanges: conflictedChanges() },
      onContinueRepositoryOperation: onContinue,
    });
    const btn = screen.getByRole("button", { name: "Continue rebase" });
    expect(btn.hasAttribute("disabled")).toBe(true);
    fireEvent.click(btn);
    expect(onContinue).not.toHaveBeenCalled();
  });
});
