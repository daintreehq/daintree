// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, renderHook } from "@testing-library/react";

const h = vi.hoisted(() => ({
  projectState: { currentProject: null as { id: string; name: string; path: string } | null },
  scratchState: {
    currentScratch: null as { id: string; name: string; path: string } | null,
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
