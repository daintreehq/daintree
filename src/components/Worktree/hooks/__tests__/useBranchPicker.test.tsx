/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useBranchPicker, type UseBranchPickerResult } from "../useBranchPicker";
import type { BranchWorktreeRef } from "../../branchPickerUtils";
import type { BranchInfo } from "@/types/electron";

const BRANCHES: BranchInfo[] = [
  { name: "main", current: true, commit: "a1" },
  { name: "develop", current: false, commit: "b2" },
  { name: "feature/auth", current: false, commit: "c3" },
  { name: "feature/billing", current: false, commit: "d4" },
];

const NO_WORKTREES: ReadonlyMap<string, BranchWorktreeRef> = new Map();

/**
 * Renders the hook and hands back a live handle. Read `current` after every
 * `act()` — the point of most of these tests is what one render resolves to.
 */
function renderPicker(
  args: {
    branches?: BranchInfo[];
    selectedBranch?: string | null;
    recentBranchNames?: string[];
    onSelect?: (option: { name: string }) => void;
  } = {}
) {
  const handle: { current: UseBranchPickerResult } = {
    current: null as unknown as UseBranchPickerResult,
  };

  function Harness() {
    handle.current = useBranchPicker({
      branches: args.branches ?? BRANCHES,
      selectedBranch: args.selectedBranch ?? null,
      recentBranchNames: args.recentBranchNames ?? [],
      worktreeByBranch: NO_WORKTREES,
      onSelect: args.onSelect ?? (() => {}),
    });
    return null;
  }

  const result = render(<Harness />);
  return { handle, ...result };
}

function keyEvent(key: string) {
  return {
    key,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as React.KeyboardEvent & { preventDefault: () => void; stopPropagation: () => void };
}

beforeEach(() => {
  // The scroll-into-view effect runs on every cursor move.
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(cleanup);

describe("useBranchPicker active index", () => {
  it("resolves to the first row when the cursor outruns a narrowed list", () => {
    const { handle } = renderPicker();

    act(() => {
      handle.current.setActiveIndex(3);
    });
    expect(handle.current.activeIndex).toBe(3);

    // "feature/a" leaves a single match, so index 3 no longer exists. Correcting
    // this in an effect would leave one render where the highlight, the active
    // descendant and Enter's target disagree.
    act(() => {
      handle.current.setQuery("feature/auth");
    });

    expect(handle.current.selectableRows).toHaveLength(1);
    expect(handle.current.activeIndex).toBe(0);
  });

  it("agrees with Enter's target in the same render", () => {
    const onSelect = vi.fn();
    const { handle } = renderPicker({ onSelect });

    act(() => {
      handle.current.setActiveIndex(3);
    });
    act(() => {
      handle.current.setQuery("develop");
    });

    const expected = handle.current.selectableRows[handle.current.activeIndex]!;
    act(() => {
      handle.current.handleKeyDown(keyEvent("Enter"));
    });

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0]![0]!.name).toBe(expected.name);
    expect(expected.name).toBe("develop");
  });

  it("reports no cursor when there are no rows at all", () => {
    const { handle } = renderPicker({ branches: [] });
    expect(handle.current.activeIndex).toBe(-1);
  });

  it("skips section rows when indexing the cursor", () => {
    const { handle } = renderPicker({ recentBranchNames: ["develop"] });

    // A "Recent" band leads the rows, but only options are addressable.
    expect(handle.current.rows[0]).toEqual({ kind: "section", label: "Recent" });
    expect(handle.current.selectableRows).toHaveLength(BRANCHES.length);
    expect(handle.current.selectableRows[0]!.name).toBe("develop");
  });
});

describe("useBranchPicker keyboard", () => {
  it("wraps past the end and before the start", () => {
    const { handle } = renderPicker();
    const last = BRANCHES.length - 1;

    act(() => {
      handle.current.setActiveIndex(last);
    });
    act(() => {
      handle.current.handleKeyDown(keyEvent("ArrowDown"));
    });
    expect(handle.current.activeIndex).toBe(0);

    act(() => {
      handle.current.handleKeyDown(keyEvent("ArrowUp"));
    });
    expect(handle.current.activeIndex).toBe(last);
  });

  it("jumps to the ends with Home and End", () => {
    const { handle } = renderPicker();

    act(() => {
      handle.current.handleKeyDown(keyEvent("End"));
    });
    expect(handle.current.activeIndex).toBe(BRANCHES.length - 1);

    act(() => {
      handle.current.handleKeyDown(keyEvent("Home"));
    });
    expect(handle.current.activeIndex).toBe(0);
  });

  it("stops navigation keys from reaching the dialog behind the portal", () => {
    const { handle } = renderPicker();
    const event = keyEvent("Enter");

    act(() => {
      handle.current.handleKeyDown(event);
    });

    // The popover portals to document.body, so an Enter that bubbled would submit
    // the form the picker is nested in.
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
  });

  it("leaves keys it does not own alone", () => {
    const { handle } = renderPicker();
    const event = keyEvent("a");

    act(() => {
      handle.current.handleKeyDown(event);
    });

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopPropagation).not.toHaveBeenCalled();
  });

  it("closes on Escape even with an empty result set", () => {
    const { handle } = renderPicker();

    act(() => {
      handle.current.setOpen(true);
    });
    act(() => {
      handle.current.setQuery("zzzznonexistent");
    });
    expect(handle.current.selectableRows).toHaveLength(0);

    const event = keyEvent("Escape");
    act(() => {
      handle.current.handleKeyDown(event);
    });

    expect(handle.current.open).toBe(false);
    expect(event.stopPropagation).toHaveBeenCalled();
  });

  it("does nothing on Enter when nothing matches", () => {
    const onSelect = vi.fn();
    const { handle } = renderPicker({ onSelect });

    act(() => {
      handle.current.setQuery("zzzznonexistent");
    });
    act(() => {
      handle.current.handleKeyDown(keyEvent("Enter"));
    });

    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe("useBranchPicker session state", () => {
  it("clears the query and cursor on every open transition", () => {
    const { handle } = renderPicker();

    act(() => {
      handle.current.setQuery("feature");
      handle.current.setActiveIndex(1);
    });
    act(() => {
      handle.current.setOpen(true);
    });

    expect(handle.current.query).toBe("");
    expect(handle.current.activeIndex).toBe(0);
  });

  it("clears them on close too, so a reopen inside the exit animation starts clean", () => {
    // Radix cancels the 120ms exit animation when the popover reopens inside it,
    // so a reset armed only on one path would be skipped and fire later.
    const { handle } = renderPicker();

    act(() => {
      handle.current.setOpen(true);
    });
    act(() => {
      handle.current.setQuery("feature");
    });
    act(() => {
      handle.current.setOpen(false);
    });

    expect(handle.current.query).toBe("");
    expect(handle.current.activeIndex).toBe(0);
  });

  it("closes itself after a selection", () => {
    const { handle } = renderPicker();

    act(() => {
      handle.current.setOpen(true);
    });
    act(() => {
      handle.current.handleSelect(handle.current.selectableRows[0]!);
    });

    expect(handle.current.open).toBe(false);
  });

  it("reset() clears the query without closing", () => {
    const { handle } = renderPicker();

    act(() => {
      handle.current.setOpen(true);
    });
    act(() => {
      handle.current.setQuery("feature");
      handle.current.setActiveIndex(1);
    });
    act(() => {
      handle.current.reset();
    });

    expect(handle.current.query).toBe("");
    expect(handle.current.activeIndex).toBe(0);
    expect(handle.current.open).toBe(true);
  });
});

describe("useBranchPicker selection", () => {
  it("resolves the committed branch to its option", () => {
    const { handle } = renderPicker({ selectedBranch: "main" });
    expect(handle.current.selectedOption?.labelText).toBe("main (current)");
  });

  it("has no selected option when the field is empty", () => {
    const { handle } = renderPicker({ selectedBranch: null });
    expect(handle.current.selectedOption).toBeUndefined();
  });

  it("counts every candidate, not just the visible rows", () => {
    const { handle } = renderPicker();

    act(() => {
      handle.current.setQuery("feature");
    });

    expect(handle.current.selectableRows.length).toBeLessThan(BRANCHES.length);
    expect(handle.current.totalCount).toBe(BRANCHES.length);
  });
});
