/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { screen, cleanup } from "@testing-library/react";
import { makeWorktree, renderWorktreeMenu } from "./worktreeMenuHarness";

afterEach(cleanup);

describe("WorktreeMenuItems — pin suppression for external worktrees (#11434)", () => {
  it("offers the pin action for an internal non-main worktree", () => {
    renderWorktreeMenu({ worktree: makeWorktree(), onTogglePin: vi.fn() });

    expect(screen.queryByText("Pin to top")).not.toBeNull();
  });

  it("withholds the pin action for an external worktree even when a callback is supplied", () => {
    // Sorting already sinks external worktrees below the pinned area, so an
    // offered pin command would be a no-op the user can't explain.
    renderWorktreeMenu({ worktree: makeWorktree({ isExternal: true }), onTogglePin: vi.fn() });

    expect(screen.queryByText("Pin to top")).toBeNull();
  });

  it("withholds the unpin action for an external worktree carrying a stale pin", () => {
    renderWorktreeMenu({
      worktree: makeWorktree({ isExternal: true }),
      onTogglePin: vi.fn(),
      isPinned: true,
    });

    expect(screen.queryByText("Unpin")).toBeNull();
  });

  it("keeps offering the pin action when classification is unknown", () => {
    renderWorktreeMenu({ worktree: makeWorktree({ isExternal: undefined }), onTogglePin: vi.fn() });

    expect(screen.queryByText("Pin to top")).not.toBeNull();
  });

  it("withholds the pin action for the main worktree", () => {
    renderWorktreeMenu({
      worktree: makeWorktree({ isMainWorktree: true }),
      onTogglePin: vi.fn(),
    });

    expect(screen.queryByText("Pin to top")).toBeNull();
  });

  it("drops the whole Organize submenu when nothing about the card can be organized", () => {
    // External + no collapse + no move rows: an Organize trigger opening onto
    // nothing is worse than no trigger.
    renderWorktreeMenu({ worktree: makeWorktree({ isExternal: true }), onTogglePin: vi.fn() });

    expect(screen.queryByText("Organize")).toBeNull();
  });
});
