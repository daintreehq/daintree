/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import {
  useBranchPicker,
  type BranchPickerKeyEvent,
  type UseBranchPickerResult,
} from "../useBranchPicker";
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
    branches?: readonly BranchInfo[];
    selectedBranch?: string | null;
    recentBranchNames?: string[];
    onSelect?: (option: { name: string }) => void;
  } = {}
) {
  /**
   * Every render, in order. Asserting only after `act()` cannot tell read-time
   * clamping apart from the effect-based reset this replaced: an effect produces
   * a stale render and then a corrected one, and `act()` flushes both before the
   * assertion runs. The history exposes that intermediate render.
   */
  const renders: { query: string; activeIndex: number; count: number }[] = [];
  let latest: UseBranchPickerResult | null = null;

  // Recorded through a prop rather than by assigning to these bindings inside the
  // component, which the react-compiler lint rightly forbids during render.
  const record = (picker: UseBranchPickerResult): void => {
    latest = picker;
    renders.push({
      query: picker.query,
      activeIndex: picker.activeIndex,
      count: picker.selectableRows.length,
    });
  };

  function Harness({
    branches,
    onRender,
  }: {
    branches: readonly BranchInfo[];
    onRender: (picker: UseBranchPickerResult) => void;
  }) {
    onRender(
      useBranchPicker({
        branches,
        selectedBranch: args.selectedBranch ?? null,
        recentBranchNames: args.recentBranchNames ?? [],
        worktreeByBranch: NO_WORKTREES,
        onSelect: args.onSelect ?? (() => {}),
      })
    );
    return null;
  }

  const result = render(<Harness branches={args.branches ?? BRANCHES} onRender={record} />);
  const setBranches = (branches: readonly BranchInfo[]) =>
    result.rerender(<Harness branches={branches} onRender={record} />);

  const handle = {
    get current(): UseBranchPickerResult {
      if (!latest) throw new Error("harness has not rendered yet");
      return latest;
    },
  };

  return { handle, renders, setBranches, ...result };
}

/**
 * `handleKeyDown` declares the structural subset it reads, so a minimal object
 * satisfies it directly — no cast, and the compiler flags any field the handler
 * starts depending on.
 */
function keyEvent(
  key: string,
  {
    metaKey = false,
    ctrlKey = false,
    altKey = false,
    ...nativeEvent
  }: {
    isComposing?: boolean;
    keyCode?: number;
    metaKey?: boolean;
    ctrlKey?: boolean;
    altKey?: boolean;
  } = {}
) {
  return {
    key,
    metaKey,
    ctrlKey,
    altKey,
    nativeEvent: { isComposing: false, keyCode: 0, ...nativeEvent },
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } satisfies BranchPickerKeyEvent;
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

    act(() => {
      handle.current.setQuery("feature/auth");
    });

    expect(handle.current.selectableRows).toHaveLength(1);
    expect(handle.current.activeIndex).toBe(0);
  });

  it("never renders an out-of-range cursor, not even for one frame", () => {
    // The invariant this whole design exists for. The previous implementation
    // corrected the index in a `useEffect`, so the render that first carried the
    // narrowed rows still exposed the old index — long enough for the highlight,
    // `aria-activedescendant` and Enter's target to disagree.
    const { handle, renders } = renderPicker();

    act(() => {
      handle.current.setActiveIndex(3);
    });
    act(() => {
      handle.current.setQuery("feature/auth");
    });

    const narrowed = renders.filter((r) => r.count === 1);
    expect(narrowed.length).toBeGreaterThan(0);
    for (const render of narrowed) {
      expect(render.activeIndex).toBeLessThan(render.count);
      expect(render.activeIndex).toBeGreaterThanOrEqual(0);
    }
  });

  it("clamps when the branch list itself shrinks under a parked cursor", () => {
    // No query change here, so nothing rewinds the raw cursor — only the
    // read-time clamp can keep the index addressable.
    const { handle, renders, setBranches } = renderPicker();

    act(() => {
      handle.current.setActiveIndex(3);
    });
    expect(handle.current.activeIndex).toBe(3);

    act(() => {
      setBranches(BRANCHES.slice(0, 2));
    });

    expect(handle.current.selectableRows).toHaveLength(2);
    expect(handle.current.activeIndex).toBe(0);
    for (const render of renders) {
      expect(render.activeIndex).toBeLessThan(Math.max(render.count, 1));
    }
  });

  it("does not resurrect an out-of-range cursor when the list widens again", () => {
    // Read-time clamping alone would hide index 3 while one row matched and then
    // hand it back when the query cleared, jumping the cursor to an unrelated
    // branch the user never navigated to.
    const { handle } = renderPicker();

    act(() => {
      handle.current.setActiveIndex(3);
    });
    act(() => {
      handle.current.setQuery("feature/auth");
    });
    expect(handle.current.activeIndex).toBe(0);

    act(() => {
      handle.current.setQuery("");
    });

    expect(handle.current.selectableRows).toHaveLength(BRANCHES.length);
    expect(handle.current.activeIndex).toBe(0);
  });

  it("rewinds the cursor on every edit, not only when the list shrinks", () => {
    const { handle } = renderPicker();

    act(() => {
      handle.current.setActiveIndex(1);
    });
    // "feature" leaves two rows, so index 1 is still in range and read-time
    // clamping would happily keep it. Only an actual rewind returns to the top,
    // which is what distinguishes this from the clamp above.
    act(() => {
      handle.current.setQuery("feature");
    });

    expect(handle.current.selectableRows).toHaveLength(2);
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

  it("yields Enter and arrows to an in-flight IME composition", () => {
    // Mid-composition these keys belong to the IME — Enter commits the candidate.
    // Selecting a branch and closing the popover instead would be data loss for
    // anyone typing CJK.
    const onSelect = vi.fn();
    const { handle } = renderPicker({ onSelect });

    const composingEnter = keyEvent("Enter", { isComposing: true });
    act(() => {
      handle.current.handleKeyDown(composingEnter);
    });

    expect(onSelect).not.toHaveBeenCalled();
    expect(composingEnter.preventDefault).not.toHaveBeenCalled();

    // Chromium can report 229 before `isComposing` flips true.
    const legacyComposing = keyEvent("ArrowDown", { keyCode: 229 });
    act(() => {
      handle.current.handleKeyDown(legacyComposing);
    });

    expect(handle.current.activeIndex).toBe(0);
    expect(legacyComposing.preventDefault).not.toHaveBeenCalled();
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

  it("closing is the whole reset, so a caller needs no second call", () => {
    // The dialog resets a picker on mode switch and on reopen by closing it. If
    // closing left the query behind, those call sites would silently keep it.
    const { handle } = renderPicker();

    act(() => {
      handle.current.setOpen(true);
    });
    act(() => {
      handle.current.setQuery("feature");
      handle.current.setActiveIndex(1);
    });
    act(() => {
      handle.current.setOpen(false);
    });

    expect(handle.current.open).toBe(false);
    expect(handle.current.query).toBe("");
    expect(handle.current.activeIndex).toBe(0);
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

  it("reports matches — not all branches — as the total while searching", () => {
    // The footnote compares this to the rows on screen, so during a search it has
    // to mean "matched", or a capped search would claim to have hidden branches
    // that never matched at all.
    const { handle } = renderPicker();
    expect(handle.current.matchedTotal).toBe(BRANCHES.length);

    act(() => {
      handle.current.setQuery("feature");
    });

    expect(handle.current.matchedTotal).toBe(2);
    expect(handle.current.selectableRows).toHaveLength(2);
  });
  it("leaves a modified Enter to the dialog's submit shortcut", () => {
    const onSelect = vi.fn();
    const { handle } = renderPicker({ onSelect });

    const chord = keyEvent("Enter", { metaKey: true });
    act(() => {
      handle.current.handleKeyDown(chord);
    });

    expect(onSelect).not.toHaveBeenCalled();
    expect(chord.preventDefault).not.toHaveBeenCalled();
    expect(chord.stopPropagation).not.toHaveBeenCalled();
  });
});
