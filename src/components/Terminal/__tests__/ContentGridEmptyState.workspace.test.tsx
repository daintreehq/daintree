// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// Hoisted mutable state so each mock reads its slice at call time and a test can
// reshape the stores before rendering.
const h = vi.hoisted(() => ({
  panelIds: [] as string[],
  panelsById: {} as Record<string, unknown>,
  recipes: { currentProjectId: null as string | null, isLoading: false },
}));

vi.mock("@/store/panelStore", () => ({
  usePanelStore: (sel: (s: typeof h) => unknown) => sel(h),
}));
vi.mock("@/store/recipeStore", () => ({
  useRecipeStore: (sel: (s: typeof h.recipes) => unknown) => sel(h.recipes),
}));
vi.mock("@/hooks/app/useHomeDir", () => ({
  useHomeDir: () => ({ homeDir: "/home/user" }),
}));

// The launcher column and the project-only strips are covered by their own
// suites; here they only need to be identifiable in the tree.
vi.mock("../LauncherQuickActions", () => ({
  LauncherQuickActions: () => <div data-testid="launcher-quick-actions" />,
}));
vi.mock("../RecipeRunner/RecipeRunner", () => ({
  RecipeRunner: () => <div data-testid="recipe-runner" />,
}));
vi.mock("../ResumeSessionLine", () => ({
  ResumeSessionLine: () => <div data-testid="resume-session-line" />,
}));
vi.mock("../contentGridTips", () => ({
  RotatingTip: () => <div data-testid="rotating-tip" />,
}));
vi.mock("@/components/Pulse", () => ({
  ProjectPulseStrip: () => <div data-testid="project-pulse" />,
}));

import { ContentGridEmptyState } from "../ContentGridEmptyState";

const PROJECT_PROPS = {
  hasLaunchTarget: true,
  hasProjectContext: true,
  hasWorktrees: true,
  isWorktreeInitialized: true,
  activeWorktreeId: "wt-1",
  activeWorktreeName: "feature",
  activeWorktreeBranch: "feature/x",
  activeWorktreePath: "/repo-worktrees/feature",
  workspaceName: "My project",
  showProjectPulse: true,
} as const;

// A scratch is an active workspace with no worktree, branch, recipes or project
// settings — the launcher must still be reachable (#11076).
const SCRATCH_PROPS = {
  hasLaunchTarget: true,
  hasProjectContext: false,
  hasWorktrees: false,
  isWorktreeInitialized: false,
  workspaceName: "Scratch 2026-07-12 09:30",
  activeWorktreePath: "/scratches/abc-123",
  showProjectPulse: false,
  defaultCwd: "/scratches/abc-123",
} as const;

// `isPtyPanel` treats a missing kind as "terminal"; hasEverLaunchedAgent then
// keys off the launch/detected agent fields.
const markLaunchedAnAgent = () => {
  h.panelIds = ["p1"];
  h.panelsById = { p1: { kind: "terminal", launchAgentId: "claude" } };
};

describe("ContentGridEmptyState — workspace capabilities", () => {
  beforeEach(() => {
    h.panelIds = [];
    h.panelsById = {};
    h.recipes.currentProjectId = null;
    h.recipes.isLoading = false;
  });

  describe("an active scratch", () => {
    it("offers the launcher instead of leaving the canvas empty", () => {
      render(<ContentGridEmptyState {...SCRATCH_PROPS} />);

      expect(screen.getByTestId("launcher-quick-actions")).toBeTruthy();
    });

    it("shows the scratch's own name and path", () => {
      render(<ContentGridEmptyState {...SCRATCH_PROPS} />);

      expect(screen.getByText(SCRATCH_PROPS.workspaceName)).toBeTruthy();
      expect(screen.getByTitle(SCRATCH_PROPS.activeWorktreePath)).toBeTruthy();
    });

    it("hides project settings — a scratch has no settings tab to open", () => {
      render(<ContentGridEmptyState {...SCRATCH_PROPS} />);

      expect(screen.queryByLabelText("Project settings")).toBeNull();
    });

    it("withholds the tip catalog, which only speaks of worktrees and project files", () => {
      markLaunchedAnAgent();

      render(<ContentGridEmptyState {...SCRATCH_PROPS} />);

      expect(screen.queryByTestId("rotating-tip")).toBeNull();
    });

    it("suppresses the project pulse", () => {
      render(<ContentGridEmptyState {...SCRATCH_PROPS} />);

      expect(screen.queryByTestId("project-pulse")).toBeNull();
    });

    it("does not offer to open a folder — the user already has a workspace", () => {
      render(<ContentGridEmptyState {...SCRATCH_PROPS} />);

      expect(screen.queryByRole("button", { name: /open folder/i })).toBeNull();
    });

    it("suppresses recipes, which are project-scoped", () => {
      render(<ContentGridEmptyState {...SCRATCH_PROPS} />);

      expect(screen.queryByTestId("recipe-runner")).toBeNull();
    });
  });

  describe("an active project", () => {
    it("keeps its settings affordance", () => {
      render(<ContentGridEmptyState {...PROJECT_PROPS} />);

      expect(screen.getByLabelText("Project settings")).toBeTruthy();
    });

    it("keeps its tips once an agent has been launched", () => {
      markLaunchedAnAgent();

      render(<ContentGridEmptyState {...PROJECT_PROPS} />);

      expect(screen.getByTestId("rotating-tip")).toBeTruthy();
    });

    // Issue #6752 — first-run users shouldn't get shortcut-carousel teaching
    // content before they've launched anything.
    it("withholds tips until the first agent launch", () => {
      render(<ContentGridEmptyState {...PROJECT_PROPS} />);

      expect(screen.queryByTestId("rotating-tip")).toBeNull();
    });

    it("shows recipes once the recipe store has settled on the project", () => {
      h.recipes.currentProjectId = "project-1";

      render(<ContentGridEmptyState {...PROJECT_PROPS} />);

      expect(screen.getByTestId("recipe-runner")).toBeTruthy();
    });

    // The CLAUDE.md recipe-gating gotcha: `loadRecipes()` sets currentProjectId
    // synchronously before the IPC resolves, so an unsettled store must stay
    // quiet rather than flash the "create your first recipe" empty state.
    it("withholds recipes while the recipe store is still loading", () => {
      h.recipes.currentProjectId = "project-1";
      h.recipes.isLoading = true;

      render(<ContentGridEmptyState {...PROJECT_PROPS} />);

      expect(screen.queryByTestId("recipe-runner")).toBeNull();
    });

    it("shows the project pulse", () => {
      render(<ContentGridEmptyState {...PROJECT_PROPS} />);

      expect(screen.getByTestId("project-pulse")).toBeTruthy();
    });

    it("honours the user's pulse hide toggle", () => {
      render(<ContentGridEmptyState {...PROJECT_PROPS} showProjectPulse={false} />);

      expect(screen.queryByTestId("project-pulse")).toBeNull();
    });
  });

  describe("no launch target", () => {
    it("withholds the launcher and the identity hero when there is nowhere to launch into", () => {
      render(
        <ContentGridEmptyState
          hasLaunchTarget={false}
          hasProjectContext
          hasWorktrees
          isWorktreeInitialized
          workspaceName="My project"
          showProjectPulse={false}
        />
      );

      expect(screen.queryByTestId("launcher-quick-actions")).toBeNull();
      expect(screen.queryByText("My project")).toBeNull();
      expect(screen.getByText("Select a worktree")).toBeTruthy();
    });

    it("offers to open a folder when the project has no worktrees at all", () => {
      render(
        <ContentGridEmptyState
          hasLaunchTarget={false}
          hasProjectContext
          hasWorktrees={false}
          isWorktreeInitialized
          showProjectPulse={false}
        />
      );

      expect(screen.getByText("Open a project folder")).toBeTruthy();
    });

    // Issue #8645 — before the worktree snapshot lands, both copy variants would
    // be a guess, so the canvas stays silent rather than flashing the wrong one.
    it("stays silent until the worktree snapshot has initialized", () => {
      render(
        <ContentGridEmptyState
          hasLaunchTarget={false}
          hasProjectContext
          hasWorktrees={false}
          isWorktreeInitialized={false}
          showProjectPulse={false}
        />
      );

      expect(screen.queryByText("Open a project folder")).toBeNull();
      expect(screen.queryByText("Select a worktree")).toBeNull();
    });
  });
});
