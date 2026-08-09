/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ExistingBranchPicker } from "../ExistingBranchPicker";
import { optionRow, stubController } from "./branchPickerFixtures";
import type { BranchPickerRow } from "../../branchPickerUtils";
import type { UseBranchPickerResult } from "../../hooks/useBranchPicker";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
});

afterEach(cleanup);

function renderPicker(
  rows: BranchPickerRow[] = [],
  overrides: Partial<Omit<UseBranchPickerResult, "rows" | "selectableRows">> = {},
  props: Partial<Parameters<typeof ExistingBranchPicker>[0]> = {}
) {
  const controller = stubController(rows, overrides);
  const result = render(
    <ExistingBranchPicker selectedBranch={null} controller={controller} {...props} />
  );
  return { ...result, controller };
}

describe("ExistingBranchPicker trigger", () => {
  it("keeps the testid the dialog suite addresses it by", () => {
    renderPicker();
    expect(screen.getByTestId("existing-branch-picker")).toBeTruthy();
  });

  it("prompts for a local branch when none is chosen", () => {
    renderPicker();
    expect(screen.getByTestId("existing-branch-picker").textContent).toContain(
      "Select a local branch..."
    );
  });

  it("shows the chosen branch name", () => {
    renderPicker([], {}, { selectedBranch: "feature/existing-work" });
    expect(screen.getByTestId("existing-branch-picker").textContent).toContain(
      "feature/existing-work"
    );
  });
});

describe("ExistingBranchPicker panel wiring", () => {
  it("gets the same keyboard-navigable panel as the base-branch field", () => {
    // This field used to have no key handling at all — mouse only.
    renderPicker([optionRow("develop"), optionRow("feature/existing-work")]);

    // Addressed by label, not role: the trigger is a combobox too. Asserted as
    // relationships rather than literal ids — this field used to expose neither.
    const input = screen.getByLabelText("Search existing branches");
    const listbox = screen.getByRole("listbox");
    const cursor = screen
      .getAllByRole("option")
      .find((el) => el.getAttribute("aria-selected") === "true");

    expect(input.getAttribute("aria-controls")).toBe(listbox.id);
    expect(cursor!.id).not.toBe("");
    expect(input.getAttribute("aria-activedescendant")).toBe(cursor!.id);
    // Distinct from the base field's, so two mounted panels can't collide.
    expect(listbox.id).not.toBe("branch-list");
  });

  it("forwards keystrokes to the controller", () => {
    const handleKeyDown = vi.fn();
    renderPicker([optionRow("develop")], { handleKeyDown });

    fireEvent.keyDown(screen.getByLabelText("Search existing branches"), { key: "ArrowDown" });

    expect(handleKeyDown).toHaveBeenCalled();
  });

  it("never marks a branch as checked out, since it only lists free ones", () => {
    renderPicker([optionRow("develop", { isCurrent: true })]);
    expect(screen.getAllByRole("option")[0]!.textContent).toBe("develop");
  });

  it("renders existing-mode zero-data copy", () => {
    renderPicker([], { query: "" });
    expect(screen.getByText("No available local branches")).toBeTruthy();
    expect(document.body.querySelector("[aria-live]")).toBeNull();
    expect(document.body.querySelector("[aria-describedby]")).toBeNull();
  });

  it("renders filtered-empty copy with the query interpolated", () => {
    renderPicker([], { query: "feature/foo" });
    expect(screen.getByText('No matches for "feature/foo"')).toBeTruthy();
  });

  it("falls back to zero-data copy for a whitespace-only query", () => {
    renderPicker([], { query: "   " });
    expect(screen.getByText("No available local branches")).toBeTruthy();
  });

  it("selects the clicked branch", () => {
    const handleSelect = vi.fn();
    const rows = [optionRow("develop"), optionRow("feature/existing-work")];
    renderPicker(rows, { handleSelect });

    fireEvent.click(screen.getAllByRole("option")[1]!);

    expect(handleSelect.mock.calls[0]![0]).toBe(rows[1]);
  });
});
