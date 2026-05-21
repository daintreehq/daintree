// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { useRef, useState } from "react";
import type { VirtuosoHandle } from "react-virtuoso";
import {
  useWorktreeSidebarKeyboard,
  type SidebarKeyboardItem,
  getWorktreeSidebarRowId,
} from "../useWorktreeSidebarKeyboard";

// jsdom doesn't compute layout, so offsetParent is always null and
// getClientRects() is empty. Patch HTMLElement to look visible so the
// hook's toolbar-item filter doesn't reject every match.
const originalGetClientRects = HTMLElement.prototype.getClientRects;
beforeAll(() => {
  HTMLElement.prototype.getClientRects = function () {
    return [{ width: 1, height: 1 } as DOMRect] as unknown as DOMRectList;
  };
});
afterAll(() => {
  HTMLElement.prototype.getClientRects = originalGetClientRects;
});

interface HarnessProps {
  items: SidebarKeyboardItem[];
  onKeyboardReorder?: (worktreeId: string, delta: -1 | 1) => void;
  onSelectWorktree?: (worktreeId: string) => void;
}

function Harness({ items, onKeyboardReorder, onSelectWorktree }: HarnessProps) {
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  const scrollerRef = useRef<HTMLElement | null>(null);
  const [latestItems] = useState(items);
  const {
    gridRef,
    activeDescendantId,
    handleGridKeyDown,
    handleGridFocus,
    handleGridFocusCapture,
  } = useWorktreeSidebarKeyboard({
    items: latestItems,
    virtuosoRef,
    scrollerRef,
    onKeyboardReorder,
    onSelectWorktree,
  });
  return (
    <div
      ref={gridRef}
      role="grid"
      tabIndex={0}
      aria-activedescendant={activeDescendantId}
      data-testid="grid"
      onKeyDown={handleGridKeyDown}
      onFocus={handleGridFocus}
      onFocusCapture={handleGridFocusCapture}
    >
      {latestItems.map((item) =>
        item.kind === "row" ? (
          <div
            key={item.worktreeId}
            id={getWorktreeSidebarRowId(item.worktreeId)}
            role="row"
            data-worktree-row={item.worktreeId}
            tabIndex={-1}
          >
            <div data-worktree-row-toolbar="">
              <button data-testid={`tb-${item.worktreeId}-1`}>One</button>
              <button data-testid={`tb-${item.worktreeId}-2`}>Two</button>
            </div>
          </div>
        ) : (
          <div key="header" role="row" data-testid="header" />
        )
      )}
    </div>
  );
}

const ITEMS: SidebarKeyboardItem[] = [
  { kind: "row", worktreeId: "wt1" },
  { kind: "row", worktreeId: "wt2" },
  { kind: "row", worktreeId: "wt3" },
];

const GROUPED_ITEMS: SidebarKeyboardItem[] = [
  { kind: "header" },
  { kind: "row", worktreeId: "wt1" },
  { kind: "row", worktreeId: "wt2" },
  { kind: "header" },
  { kind: "row", worktreeId: "wt3" },
];

describe("useWorktreeSidebarKeyboard — list navigation", () => {
  it("ArrowDown advances the active descendant past the first row when the grid is focused", () => {
    const { getByTestId } = render(<Harness items={ITEMS} />);
    const grid = getByTestId("grid");
    grid.focus();
    // First ArrowDown lands on the first row (no prior active).
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    expect(grid.getAttribute("aria-activedescendant")).toBe(getWorktreeSidebarRowId("wt2"));
  });

  it("j and k aliases mirror ArrowDown / ArrowUp", () => {
    const { getByTestId } = render(<Harness items={ITEMS} />);
    const grid = getByTestId("grid");
    grid.focus();
    fireEvent.keyDown(grid, { key: "j" });
    expect(grid.getAttribute("aria-activedescendant")).toBe(getWorktreeSidebarRowId("wt2"));
    fireEvent.keyDown(grid, { key: "k" });
    expect(grid.getAttribute("aria-activedescendant")).toBe(getWorktreeSidebarRowId("wt1"));
  });

  it("ArrowDown skips header sentinels in grouped lists", () => {
    const { getByTestId } = render(<Harness items={GROUPED_ITEMS} />);
    const grid = getByTestId("grid");
    grid.focus();
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    expect(grid.getAttribute("aria-activedescendant")).toBe(getWorktreeSidebarRowId("wt2"));
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    // wt2 → wt3, skipping the second header.
    expect(grid.getAttribute("aria-activedescendant")).toBe(getWorktreeSidebarRowId("wt3"));
  });

  it("clamps at the boundary (no wrap-around)", () => {
    const { getByTestId } = render(<Harness items={ITEMS} />);
    const grid = getByTestId("grid");
    grid.focus();
    fireEvent.keyDown(grid, { key: "End" });
    expect(grid.getAttribute("aria-activedescendant")).toBe(getWorktreeSidebarRowId("wt3"));
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    // Boundary — still wt3.
    expect(grid.getAttribute("aria-activedescendant")).toBe(getWorktreeSidebarRowId("wt3"));
  });

  it("Home and End jump to the first / last row", () => {
    const { getByTestId } = render(<Harness items={ITEMS} />);
    const grid = getByTestId("grid");
    grid.focus();
    fireEvent.keyDown(grid, { key: "End" });
    expect(grid.getAttribute("aria-activedescendant")).toBe(getWorktreeSidebarRowId("wt3"));
    fireEvent.keyDown(grid, { key: "Home" });
    expect(grid.getAttribute("aria-activedescendant")).toBe(getWorktreeSidebarRowId("wt1"));
  });

  it("Space invokes onSelectWorktree on the active row", () => {
    const onSelectWorktree = vi.fn();
    const { getByTestId } = render(<Harness items={ITEMS} onSelectWorktree={onSelectWorktree} />);
    const grid = getByTestId("grid");
    grid.focus(); // onFocus seeds wt1 as the active row
    fireEvent.keyDown(grid, { key: " " });
    expect(onSelectWorktree).toHaveBeenCalledWith("wt1");
  });
});

describe("useWorktreeSidebarKeyboard — Alt+Arrow reorder", () => {
  it("calls onKeyboardReorder(worktreeId, 1) for Alt+ArrowDown on the active row", () => {
    const onKeyboardReorder = vi.fn();
    const { getByTestId } = render(<Harness items={ITEMS} onKeyboardReorder={onKeyboardReorder} />);
    const grid = getByTestId("grid");
    grid.focus(); // → wt1 active
    fireEvent.keyDown(grid, { key: "ArrowDown", altKey: true });
    expect(onKeyboardReorder).toHaveBeenCalledWith("wt1", 1);
  });

  it("calls onKeyboardReorder(worktreeId, -1) for Alt+ArrowUp on the active row", () => {
    const onKeyboardReorder = vi.fn();
    const { getByTestId } = render(<Harness items={ITEMS} onKeyboardReorder={onKeyboardReorder} />);
    const grid = getByTestId("grid");
    grid.focus();
    fireEvent.keyDown(grid, { key: "ArrowDown" }); // wt1 → wt2
    fireEvent.keyDown(grid, { key: "ArrowUp", altKey: true });
    expect(onKeyboardReorder).toHaveBeenLastCalledWith("wt2", -1);
  });

  it("ignores Alt+ArrowLeft (only Alt+ArrowUp/Down carve through)", () => {
    const onKeyboardReorder = vi.fn();
    const { getByTestId } = render(<Harness items={ITEMS} onKeyboardReorder={onKeyboardReorder} />);
    const grid = getByTestId("grid");
    grid.focus();
    fireEvent.keyDown(grid, { key: "ArrowLeft", altKey: true });
    expect(onKeyboardReorder).not.toHaveBeenCalled();
  });

  it("Meta+ArrowDown bails out so global shortcuts still fire", () => {
    const onKeyboardReorder = vi.fn();
    const { getByTestId } = render(<Harness items={ITEMS} onKeyboardReorder={onKeyboardReorder} />);
    const grid = getByTestId("grid");
    grid.focus();
    fireEvent.keyDown(grid, { key: "ArrowDown", metaKey: true });
    expect(onKeyboardReorder).not.toHaveBeenCalled();
  });
});

describe("useWorktreeSidebarKeyboard — pinned rows in navigation", () => {
  const PINNED_ITEMS: SidebarKeyboardItem[] = [
    { kind: "row", worktreeId: "main", isPinned: true },
    { kind: "row", worktreeId: "integration", isPinned: true },
    { kind: "row", worktreeId: "wt1" },
    { kind: "row", worktreeId: "wt2" },
  ];

  it("starts on the first pinned row when the grid is focused", () => {
    const { getByTestId } = render(<Harness items={PINNED_ITEMS} />);
    const grid = getByTestId("grid");
    // fireEvent.focus wraps the state update in act() so the next assertion
    // observes the seeded activeWorktreeId. element.focus() doesn't flush.
    fireEvent.focus(grid);
    expect(grid.getAttribute("aria-activedescendant")).toBe(getWorktreeSidebarRowId("main"));
  });

  it("ArrowDown traverses pinned rows before entering the virtualized list", () => {
    const { getByTestId } = render(<Harness items={PINNED_ITEMS} />);
    const grid = getByTestId("grid");
    grid.focus();
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    expect(grid.getAttribute("aria-activedescendant")).toBe(getWorktreeSidebarRowId("integration"));
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    expect(grid.getAttribute("aria-activedescendant")).toBe(getWorktreeSidebarRowId("wt1"));
  });

  it("ArrowUp from the first virtualized row returns to the integration pinned row", () => {
    const { getByTestId } = render(<Harness items={PINNED_ITEMS} />);
    const grid = getByTestId("grid");
    grid.focus();
    fireEvent.keyDown(grid, { key: "End" });
    expect(grid.getAttribute("aria-activedescendant")).toBe(getWorktreeSidebarRowId("wt2"));
    fireEvent.keyDown(grid, { key: "Home" });
    expect(grid.getAttribute("aria-activedescendant")).toBe(getWorktreeSidebarRowId("main"));
  });

  it("Alt+ArrowUp on a pinned row still fires the reorder callback (caller bounds-checks)", () => {
    const onKeyboardReorder = vi.fn();
    const { getByTestId } = render(
      <Harness items={PINNED_ITEMS} onKeyboardReorder={onKeyboardReorder} />
    );
    const grid = getByTestId("grid");
    grid.focus(); // → main pinned active
    fireEvent.keyDown(grid, { key: "ArrowDown", altKey: true });
    // The hook stays agnostic; SidebarContent's handleKeyboardReorder
    // bounces the move when the worktree id isn't in the visible
    // (non-pinned) dragStartOrder. The hook itself just translates the key.
    expect(onKeyboardReorder).toHaveBeenCalledWith("main", 1);
  });
});

describe("useWorktreeSidebarKeyboard — toolbar sub-mode", () => {
  it("Enter on the active row moves focus into the first toolbar button", () => {
    const { getByTestId } = render(<Harness items={ITEMS} />);
    const grid = getByTestId("grid");
    grid.focus(); // → wt1 active
    fireEvent.keyDown(grid, { key: "Enter" });
    expect(document.activeElement).toBe(getByTestId("tb-wt1-1"));
  });

  it("ArrowRight inside the toolbar moves to the next button", () => {
    const { getByTestId } = render(<Harness items={ITEMS} />);
    const grid = getByTestId("grid");
    grid.focus();
    fireEvent.keyDown(grid, { key: "Enter" });
    const first = getByTestId("tb-wt1-1");
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(document.activeElement).toBe(getByTestId("tb-wt1-2"));
  });

  it("Escape from the toolbar returns to list mode and re-focuses the grid container", () => {
    const { getByTestId } = render(<Harness items={ITEMS} />);
    const grid = getByTestId("grid");
    grid.focus();
    fireEvent.keyDown(grid, { key: "Enter" });
    const first = getByTestId("tb-wt1-1");
    fireEvent.keyDown(first, { key: "Escape" });
    expect(document.activeElement).toBe(grid);
  });
});
