// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { useRef } from "react";
import {
  useWorktreeOverviewKeyboard,
  getWorktreeOverviewCellId,
  computeVerticalMove,
} from "../useWorktreeOverviewKeyboard";

// jsdom has no layout engine — patch getComputedStyle so the hook can sample
// the column count from its `gridTemplateColumns` track string. Three tracks
// keeps the 2D arithmetic obvious in the assertions.
const originalGetComputedStyle = window.getComputedStyle;
beforeAll(() => {
  window.getComputedStyle = ((el: Element) => {
    const real = originalGetComputedStyle(el);
    return new Proxy(real, {
      get(target, prop) {
        if (prop === "gridTemplateColumns") return "100px 100px 100px";
        return Reflect.get(target, prop);
      },
    });
  }) as typeof window.getComputedStyle;
});
afterAll(() => {
  window.getComputedStyle = originalGetComputedStyle;
});

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
window.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;

interface HarnessProps {
  worktreeIds: string[];
  sectionSizes?: readonly number[];
  hasSelection?: boolean;
  onActivate?: (id: string) => void;
  onToggleSelection?: (id: string) => void;
  onSelectRange?: (anchorId: string, targetId: string) => void;
  onSelectAll?: () => void;
  onClearSelection?: () => void;
  onEscapeWithoutSelection?: () => void;
  initialAnchor?: string | null;
}

function Harness({
  worktreeIds,
  sectionSizes,
  hasSelection = false,
  onActivate = () => {},
  onToggleSelection = () => {},
  onSelectRange = () => {},
  onSelectAll = () => {},
  onClearSelection = () => {},
  onEscapeWithoutSelection = () => {},
  initialAnchor = null,
}: HarnessProps) {
  const gridRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<string | null>(initialAnchor);
  const { activeDescendantId, handleGridKeyDown, handleGridFocus } = useWorktreeOverviewKeyboard({
    worktreeIds,
    sectionSizes,
    gridRef,
    selectionAnchorRef: anchorRef,
    onActivate,
    onToggleSelection,
    onSelectRange,
    onSelectAll,
    onClearSelection,
    onEscapeWithoutSelection,
    hasSelection,
  });
  return (
    <div
      ref={gridRef}
      role="grid"
      tabIndex={0}
      aria-activedescendant={activeDescendantId}
      data-testid="grid"
      data-anchor={anchorRef.current ?? ""}
      onKeyDown={handleGridKeyDown}
      onFocus={handleGridFocus}
    >
      {worktreeIds.map((id) => (
        <div key={id} role="gridcell" id={getWorktreeOverviewCellId(id)} data-testid={`cell-${id}`}>
          <button data-testid={`btn-${id}`}>inner-{id}</button>
        </div>
      ))}
    </div>
  );
}

const IDS = ["a", "b", "c", "d", "e", "f", "g", "h"]; // 3-column grid → 3 rows + 1 partial

describe("useWorktreeOverviewKeyboard — 2D arrow movement", () => {
  it("focus seeds the active descendant on the first cell", () => {
    const { getByTestId } = render(<Harness worktreeIds={IDS} />);
    const grid = getByTestId("grid");
    fireEvent.focus(grid);
    expect(grid.getAttribute("aria-activedescendant")).toBe(getWorktreeOverviewCellId("a"));
  });

  it("ArrowRight moves to the next cell within the row", () => {
    const { getByTestId } = render(<Harness worktreeIds={IDS} />);
    const grid = getByTestId("grid");
    fireEvent.focus(grid);
    fireEvent.keyDown(grid, { key: "ArrowRight" });
    expect(grid.getAttribute("aria-activedescendant")).toBe(getWorktreeOverviewCellId("b"));
  });

  it("ArrowLeft clamps at column 0", () => {
    const { getByTestId } = render(<Harness worktreeIds={IDS} />);
    const grid = getByTestId("grid");
    fireEvent.focus(grid);
    fireEvent.keyDown(grid, { key: "ArrowLeft" });
    expect(grid.getAttribute("aria-activedescendant")).toBe(getWorktreeOverviewCellId("a"));
  });

  it("ArrowDown moves by columnCount tracks (3 in this layout)", () => {
    const { getByTestId } = render(<Harness worktreeIds={IDS} />);
    const grid = getByTestId("grid");
    fireEvent.focus(grid);
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    expect(grid.getAttribute("aria-activedescendant")).toBe(getWorktreeOverviewCellId("d"));
  });

  it("ArrowUp from row 2 returns to row 1 in the same column", () => {
    const { getByTestId } = render(<Harness worktreeIds={IDS} />);
    const grid = getByTestId("grid");
    fireEvent.focus(grid);
    fireEvent.keyDown(grid, { key: "ArrowDown" }); // a → d
    fireEvent.keyDown(grid, { key: "ArrowRight" }); // d → e
    fireEvent.keyDown(grid, { key: "ArrowUp" }); // e → b
    expect(grid.getAttribute("aria-activedescendant")).toBe(getWorktreeOverviewCellId("b"));
  });

  it("ArrowDown past the last full row clamps to the last cell", () => {
    const { getByTestId } = render(<Harness worktreeIds={IDS} />);
    const grid = getByTestId("grid");
    fireEvent.focus(grid);
    fireEvent.keyDown(grid, { key: "End" });
    expect(grid.getAttribute("aria-activedescendant")).toBe(getWorktreeOverviewCellId("h"));
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    expect(grid.getAttribute("aria-activedescendant")).toBe(getWorktreeOverviewCellId("h"));
  });

  it("Home and End jump to the first / last cells", () => {
    const { getByTestId } = render(<Harness worktreeIds={IDS} />);
    const grid = getByTestId("grid");
    fireEvent.focus(grid);
    fireEvent.keyDown(grid, { key: "End" });
    expect(grid.getAttribute("aria-activedescendant")).toBe(getWorktreeOverviewCellId("h"));
    fireEvent.keyDown(grid, { key: "Home" });
    expect(grid.getAttribute("aria-activedescendant")).toBe(getWorktreeOverviewCellId("a"));
  });
});

describe("useWorktreeOverviewKeyboard — selection", () => {
  it("Space toggles selection on the active cell and sets the anchor", () => {
    const onToggleSelection = vi.fn();
    const { getByTestId } = render(
      <Harness worktreeIds={IDS} onToggleSelection={onToggleSelection} />
    );
    const grid = getByTestId("grid");
    fireEvent.focus(grid);
    fireEvent.keyDown(grid, { key: "ArrowRight" }); // a → b
    fireEvent.keyDown(grid, { key: " " });
    expect(onToggleSelection).toHaveBeenCalledWith("b");
  });

  it("Enter activates the focused cell", () => {
    const onActivate = vi.fn();
    const { getByTestId } = render(<Harness worktreeIds={IDS} onActivate={onActivate} />);
    const grid = getByTestId("grid");
    fireEvent.focus(grid);
    fireEvent.keyDown(grid, { key: "Enter" });
    expect(onActivate).toHaveBeenCalledWith("a");
  });

  it("Ctrl/Cmd+A selects all visible worktrees", () => {
    const onSelectAll = vi.fn();
    const { getByTestId } = render(<Harness worktreeIds={IDS} onSelectAll={onSelectAll} />);
    const grid = getByTestId("grid");
    fireEvent.focus(grid);
    fireEvent.keyDown(grid, { key: "a", metaKey: true });
    expect(onSelectAll).toHaveBeenCalledTimes(1);
  });

  it("Shift+ArrowRight extends selection from anchor to target", () => {
    const onSelectRange = vi.fn();
    const { getByTestId } = render(
      <Harness worktreeIds={IDS} initialAnchor="a" onSelectRange={onSelectRange} />
    );
    const grid = getByTestId("grid");
    fireEvent.focus(grid);
    fireEvent.keyDown(grid, { key: "ArrowRight", shiftKey: true });
    expect(onSelectRange).toHaveBeenCalledWith("a", "b");
  });

  it("Shift+ArrowDown extends selection across rows from the anchor", () => {
    const onSelectRange = vi.fn();
    const { getByTestId } = render(
      <Harness worktreeIds={IDS} initialAnchor="a" onSelectRange={onSelectRange} />
    );
    const grid = getByTestId("grid");
    fireEvent.focus(grid);
    fireEvent.keyDown(grid, { key: "ArrowDown", shiftKey: true });
    expect(onSelectRange).toHaveBeenCalledWith("a", "d");
  });

  it("Shift+Arrow without prior anchor bootstraps the anchor at the current cell", () => {
    const onSelectRange = vi.fn();
    const { getByTestId } = render(
      <Harness worktreeIds={IDS} onSelectRange={onSelectRange} initialAnchor={null} />
    );
    const grid = getByTestId("grid");
    fireEvent.focus(grid);
    fireEvent.keyDown(grid, { key: "ArrowRight", shiftKey: true });
    // anchor seeded at "a"; target "b"
    expect(onSelectRange).toHaveBeenCalledWith("a", "b");
  });
});

describe("useWorktreeOverviewKeyboard — Escape behavior", () => {
  it("Escape with no selection signals the modal-close handler", () => {
    const onEscapeWithoutSelection = vi.fn();
    const onClearSelection = vi.fn();
    const { getByTestId } = render(
      <Harness
        worktreeIds={IDS}
        hasSelection={false}
        onEscapeWithoutSelection={onEscapeWithoutSelection}
        onClearSelection={onClearSelection}
      />
    );
    const grid = getByTestId("grid");
    fireEvent.focus(grid);
    fireEvent.keyDown(grid, { key: "Escape" });
    expect(onEscapeWithoutSelection).toHaveBeenCalledTimes(1);
    expect(onClearSelection).not.toHaveBeenCalled();
  });

  it("Escape with selection clears it instead of closing", () => {
    const onEscapeWithoutSelection = vi.fn();
    const onClearSelection = vi.fn();
    const { getByTestId } = render(
      <Harness
        worktreeIds={IDS}
        hasSelection={true}
        onEscapeWithoutSelection={onEscapeWithoutSelection}
        onClearSelection={onClearSelection}
      />
    );
    const grid = getByTestId("grid");
    fireEvent.focus(grid);
    fireEvent.keyDown(grid, { key: "Escape" });
    expect(onClearSelection).toHaveBeenCalledTimes(1);
    expect(onEscapeWithoutSelection).not.toHaveBeenCalled();
  });
});

describe("useWorktreeOverviewKeyboard — filter reconciliation", () => {
  it("clamps the active worktree when it drops out of the visible set", () => {
    const { getByTestId, rerender } = render(<Harness worktreeIds={IDS} />);
    const grid = getByTestId("grid");
    fireEvent.focus(grid);
    fireEvent.keyDown(grid, { key: "End" }); // → h
    expect(grid.getAttribute("aria-activedescendant")).toBe(getWorktreeOverviewCellId("h"));
    rerender(<Harness worktreeIds={["a", "b", "c"]} />);
    // h dropped out — clamp to first visible
    expect(grid.getAttribute("aria-activedescendant")).toBe(getWorktreeOverviewCellId("a"));
  });

  it("with no visible worktrees, no descendant id is reported", () => {
    const { getByTestId } = render(<Harness worktreeIds={[]} />);
    const grid = getByTestId("grid");
    fireEvent.focus(grid);
    expect(grid.getAttribute("aria-activedescendant")).toBeNull();
  });
});

describe("getWorktreeOverviewCellId", () => {
  it("URL-encodes path-like worktree ids so spaces produce valid HTML ids", () => {
    expect(getWorktreeOverviewCellId("/Users/me/dev/worktree foo")).toBe(
      "worktree-overview-cell-%2FUsers%2Fme%2Fdev%2Fworktree%20foo"
    );
  });
});

describe("useWorktreeOverviewKeyboard — target-self guard", () => {
  it("ignores keys that bubble up from descendants (inner card buttons)", () => {
    // Space pressed on an inner button used to bubble to the grid and
    // toggle the active gridcell's selection — confirm that no longer
    // happens after the e.target gate.
    const onToggleSelection = vi.fn();
    const onActivate = vi.fn();
    const { getByTestId } = render(
      <Harness
        worktreeIds={["a", "b", "c"]}
        onToggleSelection={onToggleSelection}
        onActivate={onActivate}
      />
    );
    const grid = getByTestId("grid");
    fireEvent.focus(grid);
    const innerButton = getByTestId("btn-a");
    fireEvent.keyDown(innerButton, { key: " " });
    fireEvent.keyDown(innerButton, { key: "Enter" });
    expect(onToggleSelection).not.toHaveBeenCalled();
    expect(onActivate).not.toHaveBeenCalled();
  });
});

describe("useWorktreeOverviewKeyboard — stale anchor recovery", () => {
  it("Shift+Arrow with a hidden anchor re-seeds from the current cell", () => {
    const onSelectRange = vi.fn();
    const { getByTestId, rerender } = render(
      <Harness worktreeIds={["a", "b", "c", "d", "e", "f"]} initialAnchor="f" />
    );
    const grid = getByTestId("grid");
    fireEvent.focus(grid);
    // Filter narrows: f is no longer visible. Anchor ref still points at f.
    rerender(
      <Harness worktreeIds={["a", "b", "c"]} initialAnchor="f" onSelectRange={onSelectRange} />
    );
    fireEvent.keyDown(grid, { key: "ArrowRight", shiftKey: true });
    // The hook bootstraps the anchor at the current cell (a) and extends to b.
    expect(onSelectRange).toHaveBeenCalledWith("a", "b");
  });
});

describe("computeVerticalMove — section-aware 2D math", () => {
  // 3-column grid; section sizes [2, 3]. Flat order:
  // Section 0: A(0)=a B(1)=b
  // Section 1: C(0)=c D(1)=d E(2)=e
  const SECTION_SIZES = [2, 3];

  it("ArrowDown from a (0,0) in section 0 (partial-tail row) lands at c, column 0 of section 1", () => {
    expect(computeVerticalMove(0, 1, 3, 5, SECTION_SIZES)).toBe(2);
  });

  it("ArrowDown from b (0,1) crosses to section 1, column 1 → d (index 3)", () => {
    expect(computeVerticalMove(1, 1, 3, 5, SECTION_SIZES)).toBe(3);
  });

  it("ArrowDown from e (last cell, last section) clamps at e (no further sections)", () => {
    expect(computeVerticalMove(4, 1, 3, 5, SECTION_SIZES)).toBe(4);
  });

  it("ArrowUp from d (1,1) in section 1 returns to b (0,1) in section 0", () => {
    expect(computeVerticalMove(3, -1, 3, 5, SECTION_SIZES)).toBe(1);
  });

  it("ArrowUp from c (column 0) returns to a (column 0)", () => {
    expect(computeVerticalMove(2, -1, 3, 5, SECTION_SIZES)).toBe(0);
  });

  it("ArrowUp from a (first cell, first section) clamps at a", () => {
    expect(computeVerticalMove(0, -1, 3, 5, SECTION_SIZES)).toBe(0);
  });

  it("ArrowDown within a section moves by columnCount", () => {
    // 6 items in one section, 3 columns → row 0 to row 1
    expect(computeVerticalMove(0, 1, 3, 6, [6])).toBe(3);
  });

  it("ArrowDown from partial-tail column with no neighbour clamps to last cell of next section", () => {
    // Sections [4, 2], 3-column grid:
    // Section 0: indices 0-3 (rows: [0,1,2] / [3])
    // Section 1: indices 4-5 (row [4,5])
    // ArrowDown from index 2 (col 2) → section 0 next row is [3] which is
    // col 0 only; the cross-section branch should land at section 1's column 2,
    // but section 1 only has 2 cells → clamp to last cell of section 1 (index 5).
    expect(computeVerticalMove(2, 1, 3, 6, [4, 2])).toBe(3);
    // ArrowDown from index 3 (last in section 0) → section 1 column 0 = index 4
    expect(computeVerticalMove(3, 1, 3, 6, [4, 2])).toBe(4);
  });

  it("with no section sizes provided, treats the list as a single section", () => {
    expect(computeVerticalMove(0, 1, 3, 6, undefined)).toBe(3);
    expect(computeVerticalMove(3, -1, 3, 6, undefined)).toBe(0);
  });

  it("clamps when fromIndex is at end and ArrowDown overshoots within section", () => {
    // 5 items in one section, 3 columns. row 0: [0,1,2]; row 1: [3,4].
    // ArrowDown from 0 (col 0) → 3 (col 0, row 1). Good.
    expect(computeVerticalMove(0, 1, 3, 5, [5])).toBe(3);
    // ArrowDown from 2 (col 2, row 0) → row 1 col 2 doesn't exist → clamp last
    expect(computeVerticalMove(2, 1, 3, 5, [5])).toBe(4);
  });
});

describe("useWorktreeOverviewKeyboard — section-aware behavior in harness", () => {
  it("ArrowDown from the partial-tail row of section 1 jumps to column 0 of section 2", () => {
    // Sections [2, 3]: a,b in section 0; c,d,e in section 1.
    // Mock returns 3 columns. From a (index 0) ArrowDown → c (index 2).
    const { getByTestId } = render(
      <Harness worktreeIds={["a", "b", "c", "d", "e"]} sectionSizes={[2, 3]} />
    );
    const grid = getByTestId("grid");
    fireEvent.focus(grid);
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    expect(grid.getAttribute("aria-activedescendant")).toBe(getWorktreeOverviewCellId("c"));
  });
});
