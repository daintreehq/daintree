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
  it("names the unset state rather than showing an empty trigger", () => {
    render(
      <WorktreeSelector label="Base" worktrees={WORKTREES} selectedId={null} onChange={vi.fn()} />
    );
    expect(screen.getByRole("combobox", { name: "Base" }).textContent).toContain(
      "Choose a worktree"
    );
  });

  it("reads as unset when the chosen worktree has left the list, and recovers when it returns", () => {
    const onChange = vi.fn();
    const view = render(
      <WorktreeSelector label="Base" worktrees={WORKTREES} selectedId="wt-b" onChange={onChange} />
    );
    const trigger = () => screen.getByRole("combobox", { name: "Base" });
    expect(trigger().textContent).toContain("feature/x");

    view.rerender(
      <WorktreeSelector
        label="Base"
        worktrees={[WORKTREES[0]!]}
        selectedId="wt-b"
        onChange={onChange}
      />
    );
    expect(trigger().textContent).toContain("Choose a worktree");

    view.rerender(
      <WorktreeSelector
        label="Base"
        worktrees={[WORKTREES[0]!, worktree("wt-b", "feature/y")]}
        selectedId="wt-b"
        onChange={onChange}
      />
    );
    expect(trigger().textContent).toContain("feature/y");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("names a chosen worktree that loses its branch as detached", () => {
    const onChange = vi.fn();
    const view = render(
      <WorktreeSelector
        label="Compare"
        worktrees={WORKTREES}
        selectedId="wt-b"
        onChange={onChange}
      />
    );
    const trigger = () => screen.getByRole("combobox", { name: "Compare" });
    expect(trigger().textContent).toContain("feature/x");

    view.rerender(
      <WorktreeSelector
        label="Compare"
        worktrees={[WORKTREES[0]!, worktree("wt-b", undefined)]}
        selectedId="wt-b"
        onChange={onChange}
      />
    );
    expect(trigger().textContent).toContain("wt-b (detached)");
    expect(trigger().textContent).not.toContain("feature/x");
    expect(onChange).not.toHaveBeenCalled();
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
