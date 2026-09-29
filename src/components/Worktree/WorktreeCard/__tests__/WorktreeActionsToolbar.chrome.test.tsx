/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { ReactNode } from "react";
import type { WorktreeState } from "@shared/types";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreeActionsToolbar } from "../WorktreeActionsToolbar";

vi.mock("react-dom", async () => {
  const actual = await vi.importActual<typeof import("react-dom")>("react-dom");
  return { ...actual, createPortal: (children: ReactNode) => children };
});

afterEach(cleanup);

const noop = () => {};

const worktree: WorktreeState = {
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

const menu = {
  launchAgents: [],
  recipes: [],
  runningRecipeId: null,
  counts: { grid: 0, dock: 0, active: 0, completed: 0, all: 0, waiting: 0, working: 0 },
  onCopyContextFull: noop,
  onCopyContextModified: noop,
  onCopyPath: noop,
  onCopyBranchName: noop,
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

function renderToolbar(isCollapsed: boolean) {
  return render(
    <TooltipProvider delayDuration={0}>
      <WorktreeActionsToolbar
        isCollapsed={isCollapsed}
        isActive={false}
        onCleanupWorktree={noop}
        canCollapse={true}
        onToggleCollapse={noop}
        contentId="content-id"
        menu={menu}
        worktree={worktree}
        isPinned={false}
      />
    </TooltipProvider>
  );
}

function toolbarButtons(): HTMLButtonElement[] {
  return Array.from(screen.getByRole("toolbar").querySelectorAll<HTMLButtonElement>("button"));
}

describe("WorktreeActionsToolbar button chrome", () => {
  it("gives every toolbar button the same corner radius, so hover and focus shapes match", () => {
    renderToolbar(false);
    const radii = toolbarButtons().map((button) =>
      Array.from(button.classList)
        .filter((cls) => /^rounded(-|$)/.test(cls))
        .join(" ")
    );

    expect(radii.length).toBe(3);
    expect(radii[0]).not.toBe("");
    expect(new Set(radii).size).toBe(1);
  });

  it("never lets a toolbar button act as a submit button", () => {
    renderToolbar(false);

    for (const button of toolbarButtons()) {
      expect(button.getAttribute("type")).toBe("button");
    }
  });

  it.each([
    [false, "Collapse card"],
    [true, "Expand card"],
  ])("names the chevron's action in a tooltip (collapsed=%s)", async (isCollapsed, label) => {
    renderToolbar(isCollapsed);
    const chevron = screen.getByRole("button", { name: label });

    fireEvent.focus(chevron);

    expect((await screen.findByRole("tooltip")).textContent).toContain(label);
  });
});
