/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { ReactNode } from "react";
import type { WorktreeState } from "@shared/types";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreeActionsToolbar } from "../WorktreeActionsToolbar";

vi.mock("react-dom", async () => {
  const actual = await vi.importActual<typeof import("react-dom")>("react-dom");
  return { ...actual, createPortal: (children: ReactNode) => children };
});

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

const baseMenu = {
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
  onClearHistory: noop,
  onResetRenderers: noop,
  onSelectAllAgents: noop,
  onSelectWaitingAgents: noop,
  onSelectWorkingAgents: noop,
};

function renderToolbar() {
  return render(
    <TooltipProvider>
      <WorktreeActionsToolbar
        isCollapsed={false}
        isActive={false}
        onCleanupWorktree={noop}
        canCollapse={true}
        onToggleCollapse={noop}
        contentId="content-id"
        menu={baseMenu}
        worktree={baseWorktree}
        isPinned={false}
      />
    </TooltipProvider>
  );
}

function toolbarButtons(): HTMLButtonElement[] {
  const toolbar = screen.getByRole("toolbar");
  return Array.from(toolbar.querySelectorAll<HTMLButtonElement>("button:not([disabled])"));
}

describe("WorktreeActionsToolbar keyboard navigation", () => {
  it("moves focus with ArrowRight and wraps past the last button", () => {
    renderToolbar();
    const buttons = toolbarButtons();
    expect(buttons.length).toBeGreaterThanOrEqual(3);

    buttons[0]!.focus();
    fireEvent.keyDown(buttons[0]!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(buttons[1]);

    buttons[buttons.length - 1]!.focus();
    fireEvent.keyDown(buttons[buttons.length - 1]!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(buttons[0]);
  });

  it("moves focus with ArrowLeft and wraps before the first button", () => {
    renderToolbar();
    const buttons = toolbarButtons();

    buttons[1]!.focus();
    fireEvent.keyDown(buttons[1]!, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(buttons[0]);

    fireEvent.keyDown(buttons[0]!, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(buttons[buttons.length - 1]);
  });

  it("jumps to the ends with Home and End", () => {
    renderToolbar();
    const buttons = toolbarButtons();

    buttons[1]!.focus();
    fireEvent.keyDown(buttons[1]!, { key: "End" });
    expect(document.activeElement).toBe(buttons[buttons.length - 1]);

    fireEvent.keyDown(buttons[buttons.length - 1]!, { key: "Home" });
    expect(document.activeElement).toBe(buttons[0]);
  });

  it("stops handled arrow keys from reaching card-level key domains", () => {
    const outerKeyDown = vi.fn();
    render(
      <TooltipProvider>
        <div onKeyDown={outerKeyDown}>
          <WorktreeActionsToolbar
            isCollapsed={false}
            isActive={false}
            onCleanupWorktree={noop}
            canCollapse={true}
            onToggleCollapse={noop}
            contentId="content-id"
            menu={baseMenu}
            worktree={baseWorktree}
            isPinned={false}
          />
        </div>
      </TooltipProvider>
    );
    const buttons = toolbarButtons();

    buttons[0]!.focus();
    fireEvent.keyDown(buttons[0]!, { key: "ArrowRight" });
    expect(outerKeyDown).not.toHaveBeenCalled();

    fireEvent.keyDown(buttons[0]!, { key: "Enter" });
    expect(outerKeyDown).toHaveBeenCalledTimes(1);
  });

  it("leaves arrow keys alone when focus is outside the toolbar's buttons", () => {
    const outerKeyDown = vi.fn();
    render(
      <TooltipProvider>
        <div onKeyDown={outerKeyDown}>
          <WorktreeActionsToolbar
            isCollapsed={false}
            isActive={false}
            onCleanupWorktree={noop}
            canCollapse={true}
            onToggleCollapse={noop}
            contentId="content-id"
            menu={baseMenu}
            worktree={baseWorktree}
            isPinned={false}
          />
        </div>
      </TooltipProvider>
    );
    const toolbar = screen.getByRole("toolbar");
    const buttons = toolbarButtons();

    // No toolbar button focused — the handler must neither steal focus nor
    // swallow the key from surrounding key domains.
    fireEvent.keyDown(toolbar, { key: "ArrowRight" });
    expect(document.activeElement).not.toBe(buttons[0]);
    expect(outerKeyDown).toHaveBeenCalledTimes(1);
  });
});
