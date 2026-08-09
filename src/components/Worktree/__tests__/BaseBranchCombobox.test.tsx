/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { BaseBranchCombobox } from "../views/BaseBranchCombobox";
import { inUseRow, optionRow, stubController } from "../views/__tests__/branchPickerFixtures";
import { toBranchOption } from "../branchPickerUtils";
import type { BranchPickerRow } from "../branchPickerUtils";
import type { UseBranchPickerResult } from "../hooks/useBranchPicker";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
});

afterEach(cleanup);

function renderCombobox(
  rows: BranchPickerRow[] = [],
  overrides: Partial<Omit<UseBranchPickerResult, "rows" | "selectableRows">> = {},
  props: Partial<Parameters<typeof BaseBranchCombobox>[0]> = {}
) {
  const controller = stubController(rows, overrides);
  const result = render(
    <TooltipProvider>
      <BaseBranchCombobox baseBranch="develop" controller={controller} {...props} />
    </TooltipProvider>
  );
  return { ...result, controller };
}

describe("BaseBranchCombobox trigger", () => {
  it("keeps the id the dialog's validation and tests address it by", () => {
    renderCombobox();
    expect(document.getElementById("base-branch")).not.toBeNull();
  });

  it("shows the composed label so one line carries the whole answer", () => {
    // The trigger keeps "(current)"/"(remote)" inline; rows split them into badges.
    const selectedOption = toBranchOption({ name: "main", current: true, commit: "a1" });
    renderCombobox([], { selectedOption });

    expect(document.getElementById("base-branch")!.textContent).toContain("main (current)");
  });

  it("prompts when no branch is chosen yet", () => {
    renderCombobox();
    expect(document.getElementById("base-branch")!.textContent).toContain("Select base branch...");
  });

  it("flags the field as invalid only for its own error", () => {
    const { rerender } = renderCombobox([], {}, { errorField: "base-branch" });
    expect(document.getElementById("base-branch")!.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById("base-branch")!.getAttribute("aria-describedby")).toBe(
      "validation-error"
    );

    rerender(
      <TooltipProvider>
        <BaseBranchCombobox
          baseBranch="develop"
          controller={stubController([])}
          errorField="new-branch"
        />
      </TooltipProvider>
    );
    expect(document.getElementById("base-branch")!.getAttribute("aria-invalid")).toBeNull();
  });
});

describe("BaseBranchCombobox in-use rows", () => {
  it("routes a click on an in-use branch to the selection handler", () => {
    // #11716 regression guard: this used to activate that worktree and close the
    // whole dialog instead of selecting the branch.
    const handleSelect = vi.fn();
    const busy = inUseRow("main", { id: "main-wt", name: "main-worktree" });
    renderCombobox([busy, optionRow("develop")], { handleSelect });

    fireEvent.click(screen.getAllByRole("option")[0]!);

    expect(handleSelect).toHaveBeenCalledTimes(1);
    expect(handleSelect.mock.calls[0]![0]).toBe(busy);
  });

  it("labels the in-use badge with the owning worktree name, not the branch name", () => {
    renderCombobox([inUseRow("main", { id: "main-wt", name: "main-worktree" })]);
    expect(screen.getByTitle("In use by worktree: main-worktree")).toBeTruthy();
  });
});

describe("BaseBranchCombobox panel wiring", () => {
  it("forwards base-mode copy and ids into the shared panel", () => {
    renderCombobox([optionRow("main")]);

    expect(screen.getByLabelText("Search base branches")).toBeTruthy();
    expect(document.getElementById("branch-list")).not.toBeNull();
    expect(screen.getAllByRole("option")[0]!.id).toBe("branch-option-0");
  });

  it("marks the checked-out branch, which only base mode can offer", () => {
    renderCombobox([optionRow("main", { isCurrent: true })]);
    expect(screen.getAllByRole("option")[0]!.textContent).toContain("current");
  });

  it("renders base-mode zero-data copy", () => {
    renderCombobox([], { query: "" });
    expect(screen.getByText("No branches available")).toBeTruthy();
    expect(document.body.querySelector("[aria-live]")).toBeNull();
    expect(document.body.querySelector("[aria-describedby]")).toBeNull();
  });

  it("renders filtered-empty copy with the query interpolated", () => {
    renderCombobox([], { query: "feature/foo" });
    expect(screen.getByText('No matches for "feature/foo"')).toBeTruthy();
  });

  it("falls back to zero-data copy for a whitespace-only query", () => {
    renderCombobox([], { query: "   " });
    expect(screen.getByText("No branches available")).toBeTruthy();
  });

  it("checks the row matching the committed base branch", () => {
    renderCombobox([optionRow("main"), optionRow("develop")]);

    const [mainRow, developRow] = screen.getAllByRole("option");
    expect(developRow!.getAttribute("aria-current")).toBe("true");
    expect(mainRow!.getAttribute("aria-current")).toBeNull();
  });
});
