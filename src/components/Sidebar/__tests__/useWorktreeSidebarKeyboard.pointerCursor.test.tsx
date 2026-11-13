// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterAll } from "vitest";
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

// The field stands in for the sidebar search bar: ArrowDown hands the keys to
// the list through the hook's `focusFirstRow`, as `SidebarContent` wires it.
function Harness({ items = ITEMS }: { items?: SidebarKeyboardItem[] }) {
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  const scrollerRef = useRef<HTMLElement | null>(null);
  const {
    gridRef,
    activeDescendantId,
    keyboardCursorId,
    focusFirstRow,
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
        tabIndex={0}
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
    const { getByTestId } = render(<Harness />);
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

  it("skips header items when walking in from the search field", () => {
    const { getByTestId } = render(
      <Harness
        items={[{ kind: "header" }, { kind: "row", worktreeId: "wt1" }, { kind: "header" }]}
      />
    );
    const grid = getByTestId("grid");
    const search = getByTestId("search");

    focus(search);
    fireEvent.keyDown(search, { key: "ArrowDown" });

    expect(grid.dataset.cursorId).toBe("wt1");
  });

  it("keeps focus in the search field when no row is there to take it", () => {
    const { getByTestId } = render(<Harness items={[{ kind: "header" }, { kind: "header" }]} />);
    const grid = getByTestId("grid");
    const search = getByTestId("search");

    focus(search);
    fireEvent.keyDown(search, { key: "ArrowDown" });

    expect(document.activeElement).toBe(search);
    expect(grid.dataset.cursorId).toBe("");
  });

  it("keeps focus in the search field when the list is empty", () => {
    const { getByTestId } = render(<Harness items={[]} />);
    const search = getByTestId("search");

    focus(search);
    fireEvent.keyDown(search, { key: "ArrowDown" });

    expect(document.activeElement).toBe(search);
  });

  it("still shows no cursor when a pointer press focuses the grid itself", () => {
    const { getByTestId } = render(<Harness />);
    const grid = getByTestId("grid");

    fireEvent.pointerDown(grid);
    focus(grid);

    expect(grid.dataset.cursorId).toBe("");

    fireEvent.pointerUp(grid);
    expect(grid.dataset.cursorId).toBe("");
  });

  it("shows no cursor while a card is clicked", () => {
    const { getByTestId } = render(<Harness />);
    const grid = getByTestId("grid");

    clickCard(getByTestId("card-wt1"));

    expect(grid.dataset.cursorId).toBe("");
  });

  it("shows the cursor when the grid is tabbed into after a click", () => {
    const { getByTestId } = render(<Harness />);
    const grid = getByTestId("grid");

    clickCard(getByTestId("card-wt2"));
    focus(getByTestId("search"));
    focus(grid);

    expect(grid.dataset.cursorId).toBe("wt2");
  });

  it("treats a press cancelled by the browser like a release", () => {
    const { getByTestId } = render(<Harness />);
    const grid = getByTestId("grid");

    fireEvent.pointerDown(getByTestId("card-wt1"));
    fireEvent.pointerCancel(getByTestId("card-wt1"));
    focus(getByTestId("search"));
    focus(grid);

    expect(grid.dataset.cursorId).toBe("wt1");
  });

  it("ends the press when it is released outside the grid", () => {
    const { getByTestId } = render(<Harness />);
    const grid = getByTestId("grid");

    fireEvent.pointerDown(getByTestId("card-wt1"));
    fireEvent.pointerUp(document.body);
    focus(getByTestId("search"));
    focus(grid);

    expect(grid.dataset.cursorId).toBe("wt1");
  });

  it("ends the press when the window loses focus mid-press", () => {
    const { getByTestId } = render(<Harness />);
    const grid = getByTestId("grid");

    fireEvent.pointerDown(getByTestId("card-wt1"));
    fireEvent(window, new Event("blur"));
    focus(getByTestId("search"));
    focus(grid);

    expect(grid.dataset.cursorId).toBe("wt1");
  });

  it("drops its press listeners on unmount", () => {
    const removed: string[] = [];
    const originalRemove = document.removeEventListener.bind(document);
    document.removeEventListener = ((type: string, ...rest: unknown[]) => {
      removed.push(type);
      return (originalRemove as (...a: unknown[]) => void)(type, ...rest);
    }) as typeof document.removeEventListener;
    try {
      const { getByTestId, unmount } = render(<Harness />);
      fireEvent.pointerDown(getByTestId("card-wt1"));
      removed.length = 0;
      unmount();
      expect(removed).toEqual(expect.arrayContaining(["pointerup", "pointercancel"]));
    } finally {
      document.removeEventListener = originalRemove;
    }
  });
});
