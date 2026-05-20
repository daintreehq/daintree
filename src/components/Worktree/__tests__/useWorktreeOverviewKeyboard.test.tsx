// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { useRef } from "react";
import {
  useWorktreeOverviewKeyboard,
  getWorktreeOverviewCellId,
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
          {id}
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
