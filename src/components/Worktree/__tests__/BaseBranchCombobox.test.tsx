/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { createRef } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { BaseBranchCombobox } from "../views/BaseBranchCombobox";
import type { BranchPickerRow, BranchWorktreeRef } from "../branchPickerUtils";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
});

afterEach(cleanup);

function renderCombobox(overrides: Partial<Parameters<typeof BaseBranchCombobox>[0]> = {}) {
  return render(
    <TooltipProvider>
      <BaseBranchCombobox
        baseBranch="develop"
        branchPickerOpen
        onOpenChange={() => {}}
        branchQuery=""
        onQueryChange={() => {}}
        branchRows={[]}
        selectableRows={[]}
        selectedIndex={-1}
        selectedBranchLabel="develop"
        onKeyDown={() => {}}
        onSelect={() => {}}
        branchInputRef={createRef<HTMLInputElement>()}
        branchListRef={createRef<HTMLDivElement>()}
        branchOptionsLength={0}
        {...overrides}
      />
    </TooltipProvider>
  );
}

function optionRow(
  name: string,
  inUseWorktree: BranchWorktreeRef | null
): BranchPickerRow & { kind: "option" } {
  return {
    kind: "option",
    name,
    isCurrent: false,
    isRemote: false,
    remoteName: null,
    labelText: name,
    searchText: name,
    score: 0,
    matchRanges: [],
    isRecent: false,
    recentRank: 0,
    inUseWorktree,
  };
}

describe("BaseBranchCombobox in-use rows", () => {
  it("routes a click on an in-use branch to onSelect, like the Enter key does", () => {
    const onSelect = vi.fn();
    const inUseRow = optionRow("main", { id: "main-wt", name: "main-worktree" });
    const freeRow = optionRow("develop", null);
    renderCombobox({
      branchRows: [inUseRow, freeRow],
      selectableRows: [inUseRow, freeRow],
      onSelect,
    });

    fireEvent.click(screen.getAllByRole("option")[0]!);

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0]![0]).toBe(inUseRow);
  });

  it("labels the in-use badge with the owning worktree name, not the branch name", () => {
    const inUseRow = optionRow("main", { id: "main-wt", name: "main-worktree" });
    renderCombobox({ branchRows: [inUseRow], selectableRows: [inUseRow] });

    expect(screen.getByTitle("In use by worktree: main-worktree")).toBeTruthy();
  });
});

describe("BaseBranchCombobox empty states", () => {
  it("renders zero-data EmptyState when no branches and no query", () => {
    const { container } = renderCombobox({ branchQuery: "", selectableRows: [] });
    expect(screen.getByText("No branches available")).toBeTruthy();
    expect(container.querySelector("[aria-live]")).toBeNull();
    expect(container.querySelector("[aria-describedby]")).toBeNull();
  });

  it("renders filtered-empty EmptyState with interpolated query", () => {
    renderCombobox({ branchQuery: "feature/foo", selectableRows: [] });
    expect(screen.getByText('No matches for "feature/foo"')).toBeTruthy();
  });

  it("falls back to zero-data copy for whitespace-only query", () => {
    renderCombobox({ branchQuery: "   ", selectableRows: [] });
    expect(screen.getByText("No branches available")).toBeTruthy();
  });
});
