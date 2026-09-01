// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, renderHook } from "@testing-library/react";

const h = vi.hoisted(() => ({
  projectState: {
    currentProject: null as {
      id: string;
      name: string;
      path: string;
      emoji?: string;
      gitBacked?: boolean;
    } | null,
  },
  scratchState: {
    currentScratch: null as { id: string; name: string; path: string } | null,
  },
  surface: {
    resolved: null as { claim: unknown; config: { id: string; name: string } } | null,
  },
}));

vi.mock("@/store", () => ({
  useProjectStore: (sel: (s: typeof h.projectState) => unknown) => sel(h.projectState),
}));
vi.mock("@/store/scratchStore", () => ({
  useScratchStore: (sel: (s: typeof h.scratchState) => unknown) => sel(h.scratchState),
}));
vi.mock("@/lazyPanels", () => ({
  LazyWelcomeScreen: () => <div data-testid="welcome-screen" />,
}));
vi.mock("@/components/Plugin/ProjectSurfaceView", () => ({
  // The surface resolver and the view module have their own suites; what is
  // under test here is that the project canvas defers to a claim when one
  // resolves, and only then.
  useProjectSurface: () => h.surface.resolved,
  ProjectSurfaceView: (props: { config: { id: string } }) => (
    <div data-testid="project-surface" data-kind={props.config.id} />
  ),
}));
vi.mock("@/components/Terminal/ContentGridEmptyState", () => ({
  // Reflect the props back out so the wiring itself is under test, not the
  // component's rendering (which has its own suite).
  ContentGridEmptyState: (props: Record<string, unknown>) => (
    <div data-testid="empty-state" data-props={JSON.stringify(props)} />
  ),
}));

import { useEmptyCanvasContent } from "../useEmptyCanvasContent";
import type { GettingStartedChecklistState } from "../useGettingStartedChecklist";

const gettingStarted: GettingStartedChecklistState = {
  visible: false,
  collapsed: false,
  checklist: null,
  showCelebration: false,
  dismiss: () => {},
  toggleCollapse: () => {},
  notifyOnboardingComplete: () => {},
  markItem: () => {},
};

const scratch = { id: "scratch-1", name: "Scratch 2026-07-12 09:30", path: "/scratches/scratch-1" };
const project = { id: "project-1", name: "My project", path: "/repo" };

const renderContent = () => renderHook(() => useEmptyCanvasContent(gettingStarted)).result;

const emptyStateProps = (): Record<string, unknown> => {
  const raw = screen.getByTestId("empty-state").getAttribute("data-props");
  return JSON.parse(raw ?? "{}");
};

describe("useEmptyCanvasContent", () => {
  beforeEach(() => {
    h.projectState.currentProject = null;
    h.scratchState.currentScratch = null;
    h.surface.resolved = null;
  });

  describe("with an active scratch", () => {
    beforeEach(() => {
      h.scratchState.currentScratch = scratch;
    });

    // The bug: a scratch nulls currentProject, which used to read as "no
    // workspace" and hand the user an acquire-a-workspace screen.
    it("gives the canvas the launcher, not the welcome screen", () => {
      render(<>{renderContent().current.emptyContent}</>);

      expect(screen.getByTestId("empty-state")).toBeTruthy();
      expect(screen.queryByTestId("welcome-screen")).toBeNull();
    });

    it("hands the empty state the scratch's identity and cwd", () => {
      render(<>{renderContent().current.emptyContent}</>);

      const props = emptyStateProps();
      expect(props.workspaceName).toBe(scratch.name);
      expect(props.activeWorktreePath).toBe(scratch.path);
      expect(props.defaultCwd).toBe(scratch.path);
    });

    it("marks the scratch as a launch target with no project affordances", () => {
      render(<>{renderContent().current.emptyContent}</>);

      const props = emptyStateProps();
      expect(props.hasLaunchTarget).toBe(true);
      expect(props.hasProjectContext).toBe(false);
      expect(props.hasWorktrees).toBe(false);
      expect(props.showProjectPulse).toBe(false);
    });

    it("keys the canvas on the scratch so switching scratches resets it", () => {
      expect(renderContent().current.workspaceId).toBe(scratch.id);
    });
  });

  describe("with an active project", () => {
    beforeEach(() => {
      h.projectState.currentProject = project;
    });

    // undefined, not null — the grid falls back to its own context-driven empty
    // state via `emptyContent ?? <ContentGridEmptyState/>`.
    it("defers to the grid's own empty state", () => {
      expect(renderContent().current.emptyContent).toBeUndefined();
    });

    it("keys the canvas on the project", () => {
      expect(renderContent().current.workspaceId).toBe(project.id);
    });

    it("still defers when a stale scratch pointer lingers", () => {
      h.scratchState.currentScratch = scratch;

      const result = renderContent().current;

      expect(result.emptyContent).toBeUndefined();
      expect(result.workspaceId).toBe(project.id);
    });
  });

  describe("with a project opened without git (#11405)", () => {
    const lightweight = {
      id: "project-2",
      name: "downloads",
      path: "/Users/someone/Downloads",
      emoji: "🌳",
      gitBacked: false,
    };

    beforeEach(() => {
      h.projectState.currentProject = lightweight;
    });

    // Deferring would hand the grid `hasLaunchTarget: ctx.hasActiveWorktree`,
    // and there is no worktree — so the folder the user just opened would offer
    // no way to start an agent in it.
    it("supplies the launcher instead of deferring to worktree-derived context", () => {
      render(<>{renderContent().current.emptyContent}</>);

      expect(emptyStateProps().hasLaunchTarget).toBe(true);
    });

    it("launches into the folder itself", () => {
      render(<>{renderContent().current.emptyContent}</>);

      const props = emptyStateProps();
      expect(props.defaultCwd).toBe(lightweight.path);
      expect(props.activeWorktreePath).toBe(lightweight.path);
      expect(props.workspaceName).toBe(lightweight.name);
    });

    it("keeps the project affordances a scratch lacks", () => {
      render(<>{renderContent().current.emptyContent}</>);

      // It is a real project row, so settings and recipes apply — unlike a
      // scratch, which has neither.
      expect(emptyStateProps().hasProjectContext).toBe(true);
    });

    it("claims no worktrees and no git-derived pulse", () => {
      render(<>{renderContent().current.emptyContent}</>);

      const props = emptyStateProps();
      expect(props.hasWorktrees).toBe(false);
      expect(props.isWorktreeInitialized).toBe(false);
      expect(props.showProjectPulse).toBe(false);
    });

    it("still defers for a git-backed project", () => {
      h.projectState.currentProject = { ...lightweight, gitBacked: undefined };

      expect(renderContent().current.emptyContent).toBeUndefined();
    });
  });

  describe("with a project plugin claiming the empty canvas (§7.8)", () => {
    const surface = {
      claim: { pluginId: "project__project-1__acme.dash", panelKindId: "k" },
      config: { id: "project:project-1/acme.dash/overview", name: "Mission Control" },
    };

    beforeEach(() => {
      h.projectState.currentProject = project;
      h.surface.resolved = surface;
    });

    it("draws the claimed surface instead of the stock launcher", () => {
      render(<>{renderContent().current.emptyContent}</>);

      expect(screen.getByTestId("project-surface").getAttribute("data-kind")).toBe(
        surface.config.id
      );
      expect(screen.queryByTestId("empty-state")).toBeNull();
    });

    it("keeps the canvas keyed on the project", () => {
      expect(renderContent().current.workspaceId).toBe(project.id);
    });

    it("still supplies the launcher for a project opened without git", () => {
      // A claim replaces the CANVAS, and the non-git branch's canvas is the
      // launcher — so the claim wins there too rather than the two racing.
      h.projectState.currentProject = { ...project, gitBacked: false };

      render(<>{renderContent().current.emptyContent}</>);

      expect(screen.getByTestId("project-surface")).toBeTruthy();
    });

    it("leaves a scratch canvas alone", () => {
      // A scratch has no project to own its surface; the resolver would return
      // null in prod, but pin the branch so a future edit cannot leak a claim
      // into a workspace it does not belong to.
      h.projectState.currentProject = null;
      h.scratchState.currentScratch = scratch;

      render(<>{renderContent().current.emptyContent}</>);

      expect(screen.getByTestId("empty-state")).toBeTruthy();
      expect(screen.queryByTestId("project-surface")).toBeNull();
    });

    it("leaves the welcome screen alone", () => {
      h.projectState.currentProject = null;

      render(<>{renderContent().current.emptyContent}</>);

      expect(screen.getByTestId("welcome-screen")).toBeTruthy();
      expect(screen.queryByTestId("project-surface")).toBeNull();
    });

    it("falls back to the stock canvas when nothing resolves", () => {
      h.surface.resolved = null;

      expect(renderContent().current.emptyContent).toBeUndefined();
    });
  });

  describe("with no workspace at all", () => {
    it("welcomes the user", () => {
      render(<>{renderContent().current.emptyContent}</>);

      expect(screen.getByTestId("welcome-screen")).toBeTruthy();
      expect(screen.queryByTestId("empty-state")).toBeNull();
    });

    it("has no workspace to key the canvas on", () => {
      expect(renderContent().current.workspaceId).toBeNull();
    });
  });
});
