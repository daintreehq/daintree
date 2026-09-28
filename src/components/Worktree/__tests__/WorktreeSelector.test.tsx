// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { WorktreeSnapshot } from "@/types";
import { WorktreeSelector } from "../WorktreeSelector";

function worktree(id: string, branch: string | undefined): WorktreeSnapshot {
  return { id, worktreeId: id, path: `/repo/${id}`, name: id, branch, isCurrent: false };
}

const WORKTREES = [worktree("wt-a", "main"), worktree("wt-b", "feature/x")];

describe("WorktreeSelector", () => {
  it("is a combobox named by its visible label", () => {
    render(
      <WorktreeSelector label="Base" worktrees={WORKTREES} selectedId={null} onChange={vi.fn()} />
    );
    expect(screen.getByRole("combobox", { name: "Base" })).toBeTruthy();
  });

  it("names the unset state rather than showing an empty trigger", () => {
    render(
      <WorktreeSelector label="Base" worktrees={WORKTREES} selectedId={null} onChange={vi.fn()} />
    );
    expect(screen.getByRole("combobox", { name: "Base" }).textContent).toContain(
      "Choose a worktree"
    );
  });

  it("ties its visible label to the picker, so pressing the label reaches it", () => {
    render(
      <WorktreeSelector
        label="Compare"
        worktrees={WORKTREES}
        selectedId="wt-a"
        onChange={vi.fn()}
      />
    );
    const trigger = screen.getByRole("combobox", { name: "Compare" });
    const label = screen.getByText("Compare");
    expect(label instanceof HTMLLabelElement && label.control).toBe(trigger);
  });
});
