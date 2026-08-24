/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import type * as React from "react";
import { render, screen, cleanup } from "@testing-library/react";
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
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- WorktreeState has ~60 fields and this render layer reads four of them; the sibling WorktreeMenuItems test builds its fixture the same way.
  return {
    id: "wt-1",
    name: "feature",
    path: "/repo/wt-1",
    branch: "feature",
    ...overrides,
  } as WorktreeState;
}

function renderMenu(worktree: WorktreeState, onTogglePin?: () => void, isPinned = false) {
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
      onCopyBranchName={vi.fn()}
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
      onTogglePin={onTogglePin}
      isPinned={isPinned}
    />
  );
}

describe("WorktreeMenuItems — pin suppression for external worktrees (#11434)", () => {
  it("offers the pin action for an internal non-main worktree", () => {
    renderMenu(makeWorktree(), vi.fn());

    expect(screen.queryByText("Pin to Top")).not.toBeNull();
  });

  it("withholds the pin action for an external worktree even when a callback is supplied", () => {
    // Sorting already sinks external worktrees below the pinned area, so an
    // offered pin command would be a no-op the user can't explain.
    renderMenu(makeWorktree({ isExternal: true }), vi.fn());

    expect(screen.queryByText("Pin to Top")).toBeNull();
  });

  it("withholds the unpin action for an external worktree carrying a stale pin", () => {
    renderMenu(makeWorktree({ isExternal: true }), vi.fn(), true);

    expect(screen.queryByText("Unpin")).toBeNull();
  });

  it("keeps offering the pin action when classification is unknown", () => {
    renderMenu(makeWorktree({ isExternal: undefined }), vi.fn());

    expect(screen.queryByText("Pin to Top")).not.toBeNull();
  });
});
