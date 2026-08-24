/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import type * as React from "react";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import type { WorktreeState } from "../../../types";
import { WorktreeMenuItems, type WorktreeMenuComponents } from "../WorktreeMenuItems";

vi.mock("@/components/Plugin/PluginContextMenuSection", () => ({
  PluginContextMenuSection: () => null,
}));

afterEach(cleanup);

const components: WorktreeMenuComponents = {
  Item: ({ children, onSelect }: { children?: React.ReactNode; onSelect?: () => void }) => (
    <button type="button" onClick={onSelect}>
      {children}
    </button>
  ),
  Label: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Separator: () => <hr />,
  Shortcut: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  Sub: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  SubTrigger: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  SubContent: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
};

function makeWorktree(overrides: Partial<WorktreeState> = {}): WorktreeState {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- WorktreeState has ~60 fields and this render layer reads four of them; the sibling WorktreeMenuItems tests build their fixtures the same way.
  return {
    id: "wt-1",
    name: "feature",
    path: "/repo/wt-1",
    branch: "feature/copy-branch-name",
    ...overrides,
  } as WorktreeState;
}

function renderMenu(worktree: WorktreeState, onCopyBranchName: () => void = vi.fn()) {
  return render(
    <WorktreeMenuItems
      worktree={worktree}
      components={components}
      launchAgents={[]}
      recipes={[]}
      runningRecipeId={null}
      counts={{ grid: 0, dock: 0, active: 0, completed: 0, all: 0, waiting: 0, working: 0 }}
      onCopyContextFull={vi.fn()}
      onCopyContextModified={vi.fn()}
      onCopyPath={vi.fn()}
      onCopyBranchName={onCopyBranchName}
      onOpenEditor={vi.fn()}
      onRevealInFinder={vi.fn()}
      onRunRecipe={vi.fn()}
      onDockAll={vi.fn()}
      onMaximizeAll={vi.fn()}
      onResetRenderers={vi.fn()}
      onSelectAllAgents={vi.fn()}
      onSelectWaitingAgents={vi.fn()}
      onSelectWorkingAgents={vi.fn()}
      onCloseAll={vi.fn()}
      onTerminateAll={vi.fn()}
      onClearHistory={vi.fn()}
    />
  );
}

describe("WorktreeMenuItems — Copy branch name (#11930)", () => {
  it("offers the item for a worktree checked out on a branch", () => {
    renderMenu(makeWorktree());

    expect(screen.queryByText("Copy branch name")).not.toBeNull();
  });

  it("withholds the item when the worktree reports no branch", () => {
    renderMenu(makeWorktree({ branch: undefined }));

    expect(screen.queryByText("Copy branch name")).toBeNull();
  });

  it("withholds the item on a detached HEAD still carrying its pre-detach branch", () => {
    renderMenu(makeWorktree({ isDetached: true }));

    expect(screen.queryByText("Copy branch name")).toBeNull();
  });

  it("invokes the supplied callback when the item is chosen", () => {
    const onCopyBranchName = vi.fn();
    renderMenu(makeWorktree(), onCopyBranchName);

    fireEvent.click(screen.getByText("Copy branch name"));

    expect(onCopyBranchName).toHaveBeenCalledTimes(1);
  });

  it("places the item directly under Copy Path, so the two copy targets read together", () => {
    renderMenu(makeWorktree());

    // Sibling order, not button indices: an index comparison stays green if a
    // separator or label gets inserted between the two, since neither renders
    // as a button.
    const copyPath = screen.getByText("Copy Path");
    const copyBranch = screen.getByText("Copy branch name");

    expect(copyPath.nextElementSibling).toBe(copyBranch);
  });
});
