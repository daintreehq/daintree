/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { screen, cleanup, fireEvent } from "@testing-library/react";
import { makeWorktree, renderWorktreeMenu } from "./worktreeMenuHarness";

afterEach(cleanup);

const onBranch = () => makeWorktree({ branch: "feature/copy-branch-name" });

describe("WorktreeMenuItems — Copy → Branch name (#11930)", () => {
  it("offers the item for a worktree checked out on a branch", () => {
    renderWorktreeMenu({ worktree: onBranch() });

    expect(screen.queryByText("Branch name")).not.toBeNull();
  });

  it("withholds the item when the worktree reports no branch", () => {
    renderWorktreeMenu({ worktree: makeWorktree({ branch: undefined }) });

    expect(screen.queryByText("Branch name")).toBeNull();
  });

  it("withholds the item on a detached HEAD still carrying its pre-detach branch", () => {
    renderWorktreeMenu({ worktree: makeWorktree({ isDetached: true }) });

    expect(screen.queryByText("Branch name")).toBeNull();
  });

  it("invokes the supplied callback when the item is chosen", () => {
    const onCopyBranchName = vi.fn();
    renderWorktreeMenu({ worktree: onBranch(), onCopyBranchName });

    fireEvent.click(screen.getByText("Branch name"));

    expect(onCopyBranchName).toHaveBeenCalledTimes(1);
  });

  it("places the item directly under Path, so the two copy targets read together", () => {
    renderWorktreeMenu({ worktree: onBranch() });

    // Sibling order, not button indices: an index comparison stays green if a
    // separator or label gets inserted between the two, since neither renders
    // as a button.
    const path = screen.getByText("Path");
    const branch = screen.getByText("Branch name");

    expect(path.nextElementSibling).toBe(branch);
  });

  it("gathers every clipboard route under one Copy submenu", () => {
    const { container } = renderWorktreeMenu({ worktree: onBranch() });

    const copySub = Array.from(container.querySelectorAll("[data-menu-sub]")).find(
      (sub) => sub.firstElementChild?.textContent?.trim() === "Copy"
    );
    const labels = Array.from(copySub?.querySelectorAll("[data-menu-item]") ?? []).map(
      (el) => el.textContent
    );

    expect(labels).toEqual(["Full context", "Modified files only", "Path", "Branch name"]);
  });
});
