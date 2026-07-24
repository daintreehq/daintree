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

/**
 * Plain-DOM stand-ins for the Radix menu primitives. The component is a pure
 * render layer over whatever `components` it is given, so both real surfaces
 * (right-click menu and the ⋯ dropdown) exercise this same tree.
 */
const components = {
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
} as unknown as WorktreeMenuComponents;

const worktree = {
  id: "wt-1",
  name: "feature",
  path: "/repo/wt-1",
  branch: "feature",
} as WorktreeState;

function renderMenu(onOpenChanges?: () => void, onOpenReviewHub?: () => void) {
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
      onOpenChanges={onOpenChanges}
      onOpenReviewHub={onOpenReviewHub}
    />
  );
}

describe("WorktreeMenuItems — Open changes (#11420)", () => {
  it("omits the item when no callback is supplied", () => {
    renderMenu(undefined);

    expect(screen.queryByText("Open changes")).toBeNull();
  });

  it("renders the item when a callback is supplied", () => {
    renderMenu(vi.fn());

    expect(screen.queryByText("Open changes")).not.toBeNull();
  });

  it("invokes the supplied callback when the item is chosen", () => {
    const onOpenChanges = vi.fn();
    renderMenu(onOpenChanges);

    fireEvent.click(screen.getByText("Open changes"));

    expect(onOpenChanges).toHaveBeenCalledTimes(1);
  });

  it("places the item before Review & Commit, so diffing reads ahead of committing", () => {
    renderMenu(vi.fn(), vi.fn());

    const labels = screen.getAllByRole("button").map((el) => el.textContent);
    const openChangesAt = labels.findIndex((t) => t?.includes("Open changes"));
    const reviewAt = labels.findIndex((t) => t?.includes("Review & Commit"));

    expect(openChangesAt).toBeGreaterThanOrEqual(0);
    expect(reviewAt).toBeGreaterThanOrEqual(0);
    expect(openChangesAt).toBeLessThan(reviewAt);
  });
});
