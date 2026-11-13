// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import { useRef } from "react";
import type { VirtuosoHandle } from "react-virtuoso";
import {
  useWorktreeSidebarKeyboard,
  type SidebarKeyboardItem,
  getWorktreeSidebarRowId,
} from "../useWorktreeSidebarKeyboard";

const originalGetClientRects = HTMLElement.prototype.getClientRects;
beforeAll(() => {
  HTMLElement.prototype.getClientRects = function () {
    return [{ width: 1, height: 1 } as DOMRect] as unknown as DOMRectList;
  };
});
afterAll(() => {
  HTMLElement.prototype.getClientRects = originalGetClientRects;
});

const ITEMS: SidebarKeyboardItem[] = [
  { kind: "row", worktreeId: "wt1" },
  { kind: "row", worktreeId: "wt2" },
];

const AFTER_HEADER: SidebarKeyboardItem[] = [
  { kind: "header" },
  { kind: "row", worktreeId: "wt1" },
  { kind: "row", worktreeId: "wt2" },
];

// Wired the way SidebarContent wires it: the field's ArrowDown hands the keys
// to the list through `focusFirstRow`, and the grid is a tab stop only while it
// has a row.
function Harness({ items = ITEMS }: { items?: SidebarKeyboardItem[] }) {
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  const scrollerRef = useRef<HTMLElement | null>(null);
  const {
    gridRef,
    activeDescendantId,
    keyboardCursorId,
    focusFirstRow,
    hasRows,
    handleGridKeyDown,
    handleGridFocus,
    handleGridFocusCapture,
  } = useWorktreeSidebarKeyboard({ items, virtuosoRef, scrollerRef });
  return (
    <div>
      <input
        data-testid="search"
        onKeyDown={(e) => {
          if (e.key !== "ArrowDown") return;
          e.preventDefault();
          focusFirstRow();
        }}
      />
      <div
        ref={gridRef}
        role="grid"
        tabIndex={hasRows ? 0 : -1}
        aria-activedescendant={activeDescendantId}
        data-cursor-id={keyboardCursorId ?? ""}
        data-testid="grid"
        onKeyDown={handleGridKeyDown}
        onFocus={handleGridFocus}
        onFocusCapture={handleGridFocusCapture}
      >
        {items.map((item, i) =>
          item.kind === "row" ? (
            <div
              key={item.worktreeId}
              id={getWorktreeSidebarRowId(item.worktreeId)}
              role="row"
              data-worktree-row={item.worktreeId}
              tabIndex={-1}
            >
              <button data-testid={`card-${item.worktreeId}`}>Card</button>
            </div>
          ) : (
            <div key={`header-${i}`} role="row" />
          )
        )}
      </div>
    </div>
  );
}

function focus(el: HTMLElement) {
  act(() => el.focus());
}

// A mouse press focuses what is under it between pointerdown and pointerup.
function clickCard(card: HTMLElement) {
  fireEvent.pointerDown(card);
  focus(card);
  fireEvent.pointerUp(card);
  fireEvent.click(card);
}

describe("useWorktreeSidebarKeyboard — keyboard cursor after a pointer press", () => {
  it("lands the cursor on the first row when the search field's ArrowDown follows earlier clicks", () => {
    const { getByTestId } = render(<Harness items={AFTER_HEADER} />);
    const grid = getByTestId("grid");
    const search = getByTestId("search");

    clickCard(getByTestId("card-wt2"));
    focus(search);
    expect(grid.dataset.cursorId).toBe("");

    fireEvent.keyDown(search, { key: "ArrowDown" });

    expect(document.activeElement).toBe(grid);
    expect(grid.dataset.cursorId).toBe("wt1");
    expect(grid.getAttribute("aria-activedescendant")).toBe(getWorktreeSidebarRowId("wt1"));
  });

  it("shows the cursor when the grid is tabbed into after a click", () => {
    const { getByTestId } = render(<Harness />);
    const grid = getByTestId("grid");
    const search = getByTestId("search");

    clickCard(getByTestId("card-wt2"));
    focus(search);
    fireEvent.keyDown(search, { key: "Tab" });
    focus(grid);

    expect(grid.dataset.cursorId).toBe("wt2");
  });

  it("shows no cursor while a card is clicked", () => {
    const { getByTestId } = render(<Harness />);
    const grid = getByTestId("grid");

    clickCard(getByTestId("card-wt1"));

    expect(grid.dataset.cursorId).toBe("");
  });

  it("shows no cursor for a focus a press caused, even one that lands after its release", () => {
    const { getByTestId } = render(<Harness />);
    const grid = getByTestId("grid");

    // A touch or pen tap focuses the grid in compatibility events after pointerup.
    fireEvent.pointerDown(grid);
    fireEvent.pointerUp(grid);
    focus(grid);

    expect(grid.dataset.cursorId).toBe("");
  });

  it("reveals the cursor on the first key after a press focused the grid", () => {
    const { getByTestId } = render(<Harness />);
    const grid = getByTestId("grid");

    fireEvent.pointerDown(grid);
    focus(grid);
    expect(grid.dataset.cursorId).toBe("");

    fireEvent.keyDown(grid, { key: "ArrowDown" });

    expect(grid.dataset.cursorId).toBe("wt2");
  });

  it("keeps the press while a held modifier repeats", () => {
    const { getByTestId } = render(<Harness />);
    const grid = getByTestId("grid");

    fireEvent.pointerDown(grid);
    fireEvent.keyDown(document.body, { key: "Shift", repeat: true });
    focus(grid);

    expect(grid.dataset.cursorId).toBe("");
  });

  it("keeps focus in the search field when only headers are listed", () => {
    const { getByTestId } = render(<Harness items={[{ kind: "header" }, { kind: "header" }]} />);
    const grid = getByTestId("grid");
    const search = getByTestId("search");

    focus(search);
    fireEvent.keyDown(search, { key: "ArrowDown" });

    expect(document.activeElement).toBe(search);
    expect(grid.dataset.cursorId).toBe("");
    expect(grid.tabIndex).toBe(-1);
  });

  it("keeps focus in the search field when the list is empty", () => {
    const { getByTestId } = render(<Harness items={[]} />);
    const grid = getByTestId("grid");
    const search = getByTestId("search");

    focus(search);
    fireEvent.keyDown(search, { key: "ArrowDown" });

    expect(document.activeElement).toBe(search);
    expect(grid.tabIndex).toBe(-1);
  });

  it("makes the grid a tab stop once a row is listed", () => {
    const { getByTestId } = render(<Harness />);

    expect(getByTestId("grid").tabIndex).toBe(0);
  });

  it("removes the document key listener it added when it unmounts", () => {
    const added = vi.spyOn(document, "addEventListener");
    const removed = vi.spyOn(document, "removeEventListener");
    try {
      const { unmount } = render(<Harness />);
      const registered = added.mock.calls.filter(
        ([type, , options]) => type === "keydown" && options === true
      );
      unmount();
      const dropped = removed.mock.calls.filter(([type]) => type === "keydown");

      expect(registered.length).toBeGreaterThan(0);
      for (const call of registered) expect(dropped).toContainEqual(call);
    } finally {
      added.mockRestore();
      removed.mockRestore();
    }
  });
});
