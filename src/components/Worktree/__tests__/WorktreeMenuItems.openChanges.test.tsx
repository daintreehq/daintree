/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { screen, cleanup, fireEvent } from "@testing-library/react";
import type { WorktreeState } from "../../../types";
import { makeWorktree, renderWorktreeMenu } from "./worktreeMenuHarness";

afterEach(cleanup);

function withChanges(count: number): Partial<WorktreeState> {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- WorktreeChanges carries per-file git metadata the menu never reads; only the list length reaches the row.
  const worktreeChanges = {
    changedFileCount: count,
    changes: Array.from({ length: count }, (_, i) => ({ path: `file-${i}.ts` })),
  } as WorktreeState["worktreeChanges"];
  return { worktreeChanges };
}

describe("WorktreeMenuItems — View uncommitted changes (#11420)", () => {
  it("omits the item when no callback is supplied", () => {
    renderWorktreeMenu();

    expect(screen.queryByText("View uncommitted changes")).toBeNull();
  });

  it("renders the item when a callback is supplied", () => {
    renderWorktreeMenu({ onOpenChanges: vi.fn() });

    expect(screen.queryByText("View uncommitted changes")).not.toBeNull();
  });

  it("invokes the supplied callback when the item is chosen", () => {
    const onOpenChanges = vi.fn();
    renderWorktreeMenu({ onOpenChanges });

    fireEvent.click(screen.getByText("View uncommitted changes"));

    expect(onOpenChanges).toHaveBeenCalledTimes(1);
  });

  it("sits inside Review, after the hub, so the hub reads as the entry point", () => {
    const { container } = renderWorktreeMenu({
      onOpenChanges: vi.fn(),
      onOpenReviewHub: vi.fn(),
      onCompareDiff: vi.fn(),
    });

    // Scoped to the Review submenu: a global index comparison would stay green
    // if the row escaped into a different submenu that happens to render later.
    const reviewSub = Array.from(container.querySelectorAll("[data-menu-sub]")).find(
      (node) => node.firstElementChild?.textContent?.trim() === "Review"
    );
    const labels = Array.from(reviewSub?.querySelectorAll("[data-menu-item]") ?? []).map((el) =>
      el.textContent?.replace(/\d+$/, "")
    );

    expect(labels).toEqual([
      "Review worktree",
      "View uncommitted changes",
      "Compare with another worktree…",
    ]);
  });

  it("carries the changed-file count into the accessible name, not just the muted slot", () => {
    renderWorktreeMenu({ onOpenChanges: vi.fn(), worktree: makeWorktree(withChanges(3)) });

    expect(screen.queryByLabelText("View uncommitted changes, 3")).not.toBeNull();
  });

  it("drops the whole Review submenu when no review route applies", () => {
    renderWorktreeMenu();

    expect(screen.queryByText("Review")).toBeNull();
  });
});
