/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { Popover } from "@/components/ui/popover";
import { BranchPickerPanel } from "../BranchPickerPanel";
import { inUseRow, optionRow, stubController } from "./branchPickerFixtures";
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

function renderPanel(
  rows: BranchPickerRow[] = [],
  overrides: Partial<Omit<UseBranchPickerResult, "rows" | "selectableRows">> = {},
  panelProps: Partial<Parameters<typeof BranchPickerPanel>[0]> = {}
) {
  const controller = stubController(rows, overrides);
  const result = render(
    <Popover open>
      <BranchPickerPanel
        controller={controller}
        selectedBranch={null}
        listId="branch-list"
        optionIdPrefix="branch-option-"
        searchPlaceholder="Search branches..."
        searchAriaLabel="Search branches"
        zeroDataTitle="No branches available"
        {...panelProps}
      />
    </Popover>
  );
  return { ...result, controller };
}

function options(): HTMLElement[] {
  return screen.getAllByRole("option");
}

describe("BranchPickerPanel cursor", () => {
  const rows = [optionRow("main"), optionRow("develop"), optionRow("feature/auth")];

  it("marks exactly one row as the cursor", () => {
    renderPanel(rows, { activeIndex: 1 });

    const selected = options().filter((el) => el.getAttribute("aria-selected") === "true");
    expect(selected).toHaveLength(1);
    expect(selected[0]!.textContent).toContain("develop");
  });

  it("points aria-activedescendant at that same row", () => {
    renderPanel(rows, { activeIndex: 2 });

    const active = screen.getByRole("combobox").getAttribute("aria-activedescendant");
    const selected = options().find((el) => el.getAttribute("aria-selected") === "true");
    expect(active).toBe(selected!.id);
  });

  it("moves the cursor to the row the pointer travels over", () => {
    const setActiveIndex = vi.fn();
    renderPanel(rows, { activeIndex: 0, setActiveIndex });

    fireEvent.pointerMove(options()[2]!);

    // One state feeds the highlight and the keyboard cursor, so the pointer
    // cannot light one row while the keyboard cursor sits on another.
    expect(setActiveIndex).toHaveBeenCalledWith(2);
  });

  it("keeps the committed value distinct from the cursor", () => {
    renderPanel(rows, { activeIndex: 0 }, { selectedBranch: "feature/auth" });

    const [cursorRow, , committedRow] = options();
    expect(cursorRow!.getAttribute("aria-selected")).toBe("true");
    expect(cursorRow!.getAttribute("aria-current")).toBeNull();

    // The committed row is announced as the current value without also claiming
    // to be the row Enter would act on.
    expect(committedRow!.getAttribute("aria-current")).toBe("true");
    expect(committedRow!.getAttribute("aria-selected")).toBe("false");
    expect(committedRow!.textContent).toContain("Currently selected");
  });

  it("drops aria-activedescendant when there is nothing to point at", () => {
    renderPanel([], { activeIndex: -1 });
    expect(screen.getByRole("combobox").getAttribute("aria-activedescendant")).toBeNull();
  });

  it("selects the clicked row", () => {
    const handleSelect = vi.fn();
    renderPanel(rows, { handleSelect });

    fireEvent.click(options()[1]!);

    expect(handleSelect).toHaveBeenCalledTimes(1);
    expect(handleSelect.mock.calls[0]![0]).toBe(rows[1]);
  });

  it("routes a click on an in-use branch to the same selection path", () => {
    // #11716 regression guard: an in-use branch must select like any other rather
    // than being diverted into activating that worktree.
    const handleSelect = vi.fn();
    const busy = inUseRow("main", { id: "main-wt", name: "main-worktree" });
    renderPanel([busy, optionRow("develop")], { handleSelect });

    fireEvent.click(options()[0]!);

    expect(handleSelect).toHaveBeenCalledTimes(1);
    expect(handleSelect.mock.calls[0]![0]).toBe(busy);
  });
});

describe("BranchPickerPanel row metadata", () => {
  it("shows the owning worktree, keyed to the worktree name not the branch", () => {
    renderPanel([inUseRow("main", { id: "main-wt", name: "main-worktree" })]);
    expect(screen.getByTitle("In use by worktree: main-worktree")).toBeTruthy();
  });

  it("shows the remote a branch came from", () => {
    renderPanel([optionRow("origin/main", { isRemote: true, remoteName: "origin" })]);
    // Scoped to the metadata span: `origin/main`'s NAME contains "origin" too, so
    // a row-wide assertion would pass with the badge deleted.
    expect(options()[0]!.querySelector("[data-branch-meta]")!.textContent).toContain("origin");
  });

  it("shows how stale a branch is when git supplied a date", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-09T12:00:00Z"));
    try {
      renderPanel([optionRow("main", { committerDate: "2026-08-07T12:00:00Z" })]);
      expect(options()[0]!.textContent).toContain("2d ago");
    } finally {
      vi.useRealTimers();
    }
  });

  it("omits the staleness slot entirely when git gave no date", () => {
    renderPanel([optionRow("main")]);
    // Bare name keeps the dialog suite's row lookup (first span) unambiguous.
    expect(options()[0]!.textContent).toBe("main");
  });

  it("marks the checked-out branch only where that status is meaningful", () => {
    const current = optionRow("main", { isCurrent: true });

    renderPanel([current], {}, { showCurrentBadge: true });
    expect(options()[0]!.textContent).toContain("current");

    cleanup();

    // Existing-branch mode lists only branches no worktree holds, so a "current"
    // marker there would describe a branch it can never offer.
    renderPanel([current]);
    expect(options()[0]!.textContent).toBe("main");
  });

  it("highlights the matched span of the name", () => {
    renderPanel([optionRow("feature/auth", { matchRanges: [[8, 11]] })]);
    const marks = document.body.querySelectorAll(".text-search-highlight-text");
    expect(Array.from(marks, (m) => m.textContent)).toEqual(["auth"]);
  });
});

describe("BranchPickerPanel empty states", () => {
  it("renders zero-data copy when there is nothing to pick", () => {
    renderPanel([], { query: "" });
    expect(screen.getByText("No branches available")).toBeTruthy();
    expect(document.body.querySelector("[aria-live]")).toBeNull();
    expect(document.body.querySelector("[aria-describedby]")).toBeNull();
  });

  it("renders filtered-empty copy with the query interpolated", () => {
    renderPanel([], { query: "feature/foo" });
    expect(screen.getByText('No matches for "feature/foo"')).toBeTruthy();
  });

  it("falls back to zero-data copy for a whitespace-only query", () => {
    renderPanel([], { query: "   " });
    expect(screen.getByText("No branches available")).toBeTruthy();
  });

  it("clears the query from the filtered-empty action", () => {
    const setQuery = vi.fn();
    renderPanel([], { query: "nope", setQuery });

    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));

    expect(setQuery).toHaveBeenCalledWith("");
  });
});

describe("BranchPickerPanel truncation footnote", () => {
  it("reports the rows on screen against the real total", () => {
    renderPanel([optionRow("a"), optionRow("b")], { matchedTotal: 732 });
    expect(screen.getByText("Showing 2 of 732 branches — search to narrow")).toBeTruthy();
  });

  it("stays hidden when nothing was withheld", () => {
    renderPanel([optionRow("a"), optionRow("b")], { matchedTotal: 2 });
    expect(screen.queryByText(/Showing .* branches/)).toBeNull();
  });

  it("reports a capped search too, not just a capped full list", () => {
    // One-character queries can now match more than the result cap, so gating the
    // footnote on "no query" would hide that truncation entirely.
    renderPanel([optionRow("a"), optionRow("b")], { query: "a", matchedTotal: 900 });
    expect(screen.getByText("Showing 2 of 900 matches — keep typing to narrow")).toBeTruthy();
  });

  it("stays hidden when a search returned everything it matched", () => {
    renderPanel([optionRow("a")], { query: "a", matchedTotal: 1 });
    expect(screen.queryByText(/Showing \d+ of \d+/)).toBeNull();
  });
});

describe("BranchPickerPanel section headers", () => {
  it("renders a band label without making it selectable", () => {
    renderPanel([{ kind: "section", label: "Recent" }, optionRow("main"), optionRow("develop")]);

    expect(screen.getByText("Recent")).toBeTruthy();
    // Sections must not consume an option index, or the cursor and
    // aria-activedescendant would address different rows.
    expect(options().map((el) => el.getAttribute("data-option-index"))).toEqual(["0", "1"]);
  });
});
