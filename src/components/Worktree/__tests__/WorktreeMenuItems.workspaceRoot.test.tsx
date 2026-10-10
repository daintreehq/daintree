/**
 * @vitest-environment jsdom
 *
 * The menu body with no worktree — the ⋯ and right-click menus of a scratch or
 * a folder opened without git (#13225). Git- and worktree-shaped groups must be
 * absent rather than disabled (#11499), and the body enforces that itself, so
 * these render with every worktree-only callback wired to prove a careless
 * caller can't bring a dead row back.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { screen, cleanup, fireEvent } from "@testing-library/react";
import { fileManagerRevealLabel } from "@/lib/platform";
import { renderWorkspaceRootMenu, rootRowLabels, rootSeparatorCount } from "./worktreeMenuHarness";
import { _resetPluginRuntimeStoreForTest } from "@/store/pluginRuntimeStore";

const dispatch = vi.hoisted(() => vi.fn());
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch } }));

afterEach(() => {
  cleanup();
  dispatch.mockClear();
  _resetPluginRuntimeStoreForTest();
});

/** Every worktree-only prop a card would pass, handed to a root by mistake. */
function worktreeOnlyProps() {
  return {
    counts: { grid: 2, dock: 1, active: 3, completed: 0, all: 3, waiting: 1, working: 2 },
    onCopyContextModified: vi.fn(),
    onCopyBranchName: vi.fn(),
    onOpenReviewHub: vi.fn(),
    onOpenChanges: vi.fn(),
    onCompareDiff: vi.fn(),
    onGitPullRebase: vi.fn(),
    onGitPush: vi.fn(),
    onGitForcePush: vi.fn(),
    canForcePush: true,
    onSaveLayout: vi.fn(),
    onTogglePin: vi.fn(),
    onToggleCollapse: vi.fn(),
    onMoveUp: vi.fn(),
    onMoveDown: vi.fn(),
    onViewPlan: vi.fn(),
    onAttachIssue: vi.fn(),
    onOpenIssueExternal: vi.fn(),
    onDeleteWorktree: vi.fn(),
    onDockAll: vi.fn(),
    onMaximizeAll: vi.fn(),
    onResetRenderers: vi.fn(),
    onSelectAllAgents: vi.fn(),
    onSelectWaitingAgents: vi.fn(),
    onSelectWorkingAgents: vi.fn(),
    onCloseAll: vi.fn(),
    onTerminateAll: vi.fn(),
    onClearHistory: vi.fn(),
    hasResourceConfig: true,
    worktreeMode: "remote",
    resourceEnvironmentKeys: ["remote"],
    onSwitchEnvironment: vi.fn(),
    onResourceStatus: vi.fn(),
    onResourceTeardown: vi.fn(),
    devServerState: "running" as const,
    onStartDevServer: vi.fn(),
    onStopDevServer: vi.fn(),
    onRestartDevServer: vi.fn(),
    pluginItems: [
      {
        pluginId: "acme",
        item: { actionId: "acme.thing", label: "Acme thing", location: "worktree" as const },
      },
    ],
  };
}

function itemLabels(): string[] {
  return screen.getAllByRole("button").map((el) => el.textContent?.trim() ?? "");
}

describe("WorktreeMenuItems — workspace root", () => {
  it("carries only Launch, Open and Copy when there are no recipes", () => {
    const { container } = renderWorkspaceRootMenu({ onOpenEditor: vi.fn() });

    expect(rootRowLabels(container)).toEqual(["Launch", "Open", "Copy"]);
    expect(rootSeparatorCount(container)).toBe(1);
  });

  it("adds Recipes beside Launch's group only when there is one to run", () => {
    const { container } = renderWorkspaceRootMenu({ recipes: [{ id: "r1", name: "Two agents" }] });

    expect(rootRowLabels(container)).toEqual(["Launch", "Open", "Recipes", "Copy"]);
    expect(rootSeparatorCount(container)).toBe(2);
  });

  it("withholds every worktree-shaped group even when its callbacks are wired", () => {
    const { container } = renderWorkspaceRootMenu({
      ...worktreeOnlyProps(),
      recipes: [{ id: "r1", name: "Two agents" }],
    });

    expect(rootRowLabels(container)).toEqual(["Launch", "Open", "Recipes", "Copy"]);
    const labels = itemLabels();
    for (const forbidden of [
      "Review",
      "Git",
      "Fetch",
      "Sessions",
      "Runtime",
      "Linked work",
      "Organize",
      "Extensions",
      "Delete worktree…",
      "Modified files only",
      "Branch name",
      "Save current layout as recipe…",
    ]) {
      expect(labels).not.toContain(forbidden);
    }
  });

  it("offers exactly Full context and Path under Copy", () => {
    const onCopyContextFull = vi.fn();
    const onCopyPath = vi.fn();
    renderWorkspaceRootMenu({ ...worktreeOnlyProps(), onCopyContextFull, onCopyPath });

    const copy = screen.getByRole("button", { name: "Copy" }).parentElement!;
    const rows = Array.from(copy.querySelectorAll("[data-menu-item]")).map((el) =>
      el.textContent?.trim()
    );
    expect(rows).toEqual(["Full context", "Path"]);

    fireEvent.click(screen.getByRole("button", { name: "Full context" }));
    fireEvent.click(screen.getByRole("button", { name: "Path" }));
    expect(onCopyContextFull).toHaveBeenCalledTimes(1);
    expect(onCopyPath).toHaveBeenCalledTimes(1);
  });

  it("offers Open in editor only when the caller wires it", () => {
    renderWorkspaceRootMenu({ onOpenFileBrowser: vi.fn() });
    expect(screen.queryByRole("button", { name: "Open in editor" })).toBeNull();
    expect(screen.getByRole("button", { name: "Browse files" })).toBeTruthy();
    expect(screen.getByRole("button", { name: fileManagerRevealLabel() })).toBeTruthy();
    cleanup();

    const onOpenEditor = vi.fn();
    renderWorkspaceRootMenu({ onOpenEditor });
    fireEvent.click(screen.getByRole("button", { name: "Open in editor" }));
    expect(onOpenEditor).toHaveBeenCalledTimes(1);
  });

  it("launches through the caller and hands the palette the resolved surface", () => {
    const onLaunchAgent = vi.fn();
    const onOpenPanelPalette = vi.fn();
    renderWorkspaceRootMenu(
      {
        launchAgents: [{ id: "claude", name: "Claude", isEnabled: true }],
        onLaunchAgent,
        onOpenPanelPalette,
      },
      "context-menu"
    );

    fireEvent.click(screen.getByRole("button", { name: "Claude" }));
    fireEvent.click(screen.getByRole("button", { name: "Terminal" }));
    fireEvent.click(screen.getByRole("button", { name: "More agents and panels…" }));

    expect(onLaunchAgent.mock.calls).toEqual([["claude"], ["terminal"]]);
    expect(onOpenPanelPalette).toHaveBeenCalledWith("context-menu");
  });

  it("runs a recipe by id and dispatches no git action", () => {
    const onRunRecipe = vi.fn();
    renderWorkspaceRootMenu({ recipes: [{ id: "r1", name: "Two agents" }], onRunRecipe });

    fireEvent.click(screen.getByRole("button", { name: "Two agents" }));

    expect(onRunRecipe).toHaveBeenCalledWith("r1");
    expect(dispatch).not.toHaveBeenCalled();
  });
});
