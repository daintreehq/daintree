// @vitest-environment jsdom
import { createElement, useState, type ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn(() => Promise.resolve()) },
}));

import * as kit from "@daintreehq/plugin-ui";
import { DndContext } from "@dnd-kit/core";
import { besideCursor, edgeScroll } from "@/components/PluginKit/PluginKitDnd";
import { TooltipProvider } from "@/components/ui/tooltip";

beforeAll(async () => {
  await kit.whenPluginUiReady();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function untyped(name: string, props: Record<string, unknown>, ...children: ReactNode[]) {
  return createElement(Reflect.get(kit, name), props, ...children);
}

function withTooltips(children: ReactNode) {
  return createElement(TooltipProvider, null, children);
}

// dnd-kit swallows clicks for 50ms after a drop.
const CLICK_GUARD_LAPSE_MS = 60;

function element(found: Element | null | undefined): HTMLElement {
  if (!(found instanceof HTMLElement)) throw new Error("no element");
  return found;
}

function liveText(): string {
  return screen
    .getAllByRole("status")
    .map((region) => region.textContent ?? "")
    .join(" ");
}

interface Task {
  id: string;
  title: string;
}

const TASKS: Task[] = [
  { id: "a", title: "Alpha" },
  { id: "b", title: "Bravo" },
  { id: "c", title: "Charlie" },
];

function rowTexts(list: HTMLElement): string[] {
  return [...list.querySelectorAll("[role=listitem]")].map((row) => row.textContent ?? "");
}

function handles(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>("[aria-roledescription]")].filter(
    (el) => el.closest("[data-kit-drag-overlay]") === null
  );
}

describe("SortableList", () => {
  function Harness(props: {
    onReorder?: (from: number, to: number) => void;
    onChange?: (items: Task[]) => void;
    handle?: boolean;
    disabledId?: string;
  }) {
    const [items, setItems] = useState(TASKS);
    return createElement(kit.SortableList<Task>, {
      items,
      "aria-label": "Priorities",
      renderItem: (item) => item.title,
      handle: props.handle,
      isItemDisabled: (item) => item.id === props.disabledId,
      onReorder: props.onReorder,
      onChange: (next) => {
        props.onChange?.(next);
        setItems(next);
      },
    });
  }

  it("draws a labelled list with one tab stop", () => {
    render(createElement(Harness));
    const list = screen.getByRole("list", { name: "Priorities" });
    expect(rowTexts(list)).toEqual(["Alpha", "Bravo", "Charlie"]);
    expect(list.hasAttribute("data-no-dnd")).toBe(true);
    const stops = handles().map((h) => h.tabIndex);
    expect(stops).toEqual([0, -1, -1]);
    expect(handles()[0]!.getAttribute("aria-roledescription")).toBe("sortable item");
    expect(handles()[0]!.getAttribute("aria-describedby")).toBeTruthy();
  });

  it("moves focus with the arrow keys before anything is picked up", () => {
    render(createElement(Harness));
    const [first, second] = handles();
    first!.focus();
    fireEvent.keyDown(first!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(second);
    expect(second!.tabIndex).toBe(0);
    expect(first!.tabIndex).toBe(-1);
  });

  it("picks up with Space, moves with arrows and drops with Space", () => {
    const onReorder = vi.fn();
    const onChange = vi.fn();
    render(createElement(Harness, { onReorder, onChange }));
    const list = screen.getByRole("list", { name: "Priorities" });
    const alpha = handles()[0]!;
    alpha.focus();
    fireEvent.keyDown(alpha, { key: " " });
    expect(alpha.getAttribute("aria-pressed")).toBe("true");
    expect(liveText()).toContain("Picked up Alpha, position 1 of 3");

    fireEvent.keyDown(alpha, { key: "ArrowDown" });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(rowTexts(list)).toEqual(["Bravo", "Charlie", "Alpha"]);
    expect(liveText()).toContain("Alpha, position 3 of 3");
    expect(list.querySelector("[data-state=lifted]")?.textContent).toBe("Alpha");
    expect(onReorder).not.toHaveBeenCalled();

    fireEvent.keyDown(document.activeElement!, { key: " " });
    expect(onReorder).toHaveBeenCalledWith(0, 2);
    expect(onChange.mock.calls[0]![0].map((t: Task) => t.id)).toEqual(["b", "c", "a"]);
    expect(rowTexts(list)).toEqual(["Bravo", "Charlie", "Alpha"]);
    expect(liveText()).toContain("Dropped Alpha, position 3 of 3");
    expect(document.activeElement?.textContent).toBe("Alpha");
  });

  it("puts the item back on Escape", () => {
    const onReorder = vi.fn();
    render(createElement(Harness, { onReorder }));
    const list = screen.getByRole("list", { name: "Priorities" });
    const bravo = handles()[1]!;
    bravo.focus();
    fireEvent.keyDown(bravo, { key: " " });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(rowTexts(list)).toEqual(["Bravo", "Alpha", "Charlie"]);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(rowTexts(list)).toEqual(["Alpha", "Bravo", "Charlie"]);
    expect(onReorder).not.toHaveBeenCalled();
    expect(liveText()).toContain("Cancelled. Bravo is back at position 2 of 3");
  });

  it("keeps the keys of a held item from reaching the host", () => {
    const outside = vi.fn();
    render(createElement("div", { onKeyDown: outside }, createElement(Harness)));
    const alpha = handles()[0]!;
    alpha.focus();
    fireEvent.keyDown(alpha, { key: " " });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(outside).not.toHaveBeenCalled();
  });

  it("does not pick up a disabled item", () => {
    const onReorder = vi.fn();
    render(createElement(Harness, { onReorder, disabledId: "a" }));
    const alpha = handles()[0]!;
    expect(alpha.getAttribute("aria-disabled")).toBe("true");
    alpha.focus();
    fireEvent.keyDown(alpha, { key: " " });
    expect(alpha.getAttribute("aria-pressed")).toBe("false");
  });

  it("draws a grip as the only handle with `handle`", () => {
    render(createElement(Harness, { handle: true }));
    const grips = handles();
    expect(grips).toHaveLength(3);
    expect(grips[0]!.getAttribute("aria-label")).toBe("Reorder Alpha");
    expect(grips[0]!.getAttribute("aria-roledescription")).toBe("drag handle");
    expect(grips[0]!.closest("[role=listitem]")?.textContent).toBe("Alpha");
  });

  it("ignores keys pressed in a control inside a row", () => {
    const onReorder = vi.fn();
    render(
      createElement(kit.SortableList<Task>, {
        items: TASKS,
        "aria-label": "Priorities",
        renderItem: (item) => createElement("button", { type: "button" }, `Edit ${item.title}`),
        onReorder,
      })
    );
    const button = element(screen.getByText("Edit Alpha").closest("button"));
    fireEvent.keyDown(button, { key: " " });
    expect(handles()[0]!.getAttribute("aria-pressed")).toBe("false");
  });

  it("starts no system drag from a row except from an element marked draggable", () => {
    render(
      createElement(kit.SortableList<Task>, {
        items: TASKS,
        "aria-label": "Priorities",
        renderItem: (item) =>
          createElement(
            "span",
            null,
            createElement("img", { alt: `${item.title} avatar` }),
            createElement("span", { draggable: true }, `Hand ${item.title} off`)
          ),
      })
    );
    const image = screen.getByAltText("Alpha avatar");
    expect(fireEvent.dragStart(image)).toBe(false);
    expect(fireEvent.dragStart(screen.getByText("Hand Alpha off"))).toBe(true);
  });

  it("follows the held item when the items change under it", () => {
    const onReorder = vi.fn();
    const { rerender } = render(
      createElement(kit.SortableList<Task>, {
        items: TASKS,
        "aria-label": "Priorities",
        renderItem: (item) => item.title,
        onReorder,
      })
    );
    const alpha = handles()[0]!;
    alpha.focus();
    fireEvent.keyDown(alpha, { key: " " });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    const zulu = { id: "z", title: "Zulu" };
    rerender(
      createElement(kit.SortableList<Task>, {
        items: [zulu, ...TASKS],
        "aria-label": "Priorities",
        renderItem: (item) => item.title,
        onReorder,
      })
    );
    fireEvent.keyDown(document.activeElement!, { key: " " });
    // Alpha, now at 1, drops at 1: the target is kept, the source follows.
    expect(onReorder).not.toHaveBeenCalled();
    expect(liveText()).toContain("Dropped Alpha. It stayed at position 2 of 4");
  });

  it("cancels the drag when the held item is removed", () => {
    const onReorder = vi.fn();
    const props = { "aria-label": "Priorities", renderItem: (item: Task) => item.title, onReorder };
    const { rerender } = render(createElement(kit.SortableList<Task>, { ...props, items: TASKS }));
    const alpha = handles()[0]!;
    alpha.focus();
    fireEvent.keyDown(alpha, { key: " " });
    rerender(createElement(kit.SortableList<Task>, { ...props, items: TASKS.slice(1) }));
    expect(liveText()).toContain("Alpha was removed. The drag was cancelled.");
    const bravo = handles()[0]!;
    bravo.focus();
    fireEvent.keyDown(bravo, { key: " " });
    expect(bravo.getAttribute("aria-pressed")).toBe("true");
  });

  it("cancels when focus leaves, and leaves focus where it went", async () => {
    const onReorder = vi.fn();
    render(
      createElement(
        "div",
        null,
        createElement(Harness, { onReorder }),
        createElement("input", { "aria-label": "Elsewhere" })
      )
    );
    const alpha = handles()[0]!;
    alpha.focus();
    fireEvent.keyDown(alpha, { key: " " });
    const elsewhere = screen.getByRole("textbox", { name: "Elsewhere" });
    act(() => elsewhere.focus());
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(alpha.getAttribute("aria-pressed")).toBe("false");
    expect(document.activeElement).toBe(elsewhere);
    expect(onReorder).not.toHaveBeenCalled();
  });

  it("puts the tab stop on the first item with a grip", () => {
    render(createElement(Harness, { handle: true, disabledId: "a" }));
    const grips = handles();
    expect(grips.map((g) => g.getAttribute("aria-label"))).toEqual([
      "Reorder Bravo",
      "Reorder Charlie",
    ]);
    expect(grips[0]!.tabIndex).toBe(0);
  });

  it("survives a renderItem that throws and a sparse items array", () => {
    const reportError = vi.fn();
    vi.stubGlobal("reportError", reportError);
    const sparse: (Task | undefined)[] = [TASKS[0]];
    sparse[2] = TASKS[1];
    render(
      untyped("SortableList", {
        items: sparse,
        "aria-label": "Rows",
        getId: (item: Task | undefined) => {
          if (!item) throw new Error("no item");
          return item.id;
        },
        renderItem: (item: Task | undefined) => {
          if (item?.id === "b") throw new Error("bad row");
          return item?.title ?? "blank";
        },
      })
    );
    vi.unstubAllGlobals();
    const list = screen.getByRole("list", { name: "Rows" });
    expect(rowTexts(list)).toEqual(["Alpha", "blank", ""]);
    expect(reportError).toHaveBeenCalled();
  });

  it("keeps ids distinct from positional keys and numbers from strings", () => {
    render(
      untyped("SortableList", {
        items: [{ id: "kit-item-1" }, {}, { id: 1 }, { id: "1" }],
        renderItem: (_item: unknown, state: { index: number }) => `row ${state.index}`,
        "aria-label": "Rows",
      })
    );
    const list = screen.getByRole("list", { name: "Rows" });
    expect(rowTexts(list)).toEqual(["row 0", "row 1", "row 2", "row 3"]);
  });

  it("degrades on untyped props", () => {
    expect(() =>
      render(
        untyped("SortableList", {
          items: "nope",
          renderItem: 3,
          "aria-label": 7,
          orientation: "diagonal",
          getId: () => {
            throw new Error("bad id");
          },
        })
      )
    ).not.toThrow();
    const list = screen.getByRole("list", { name: "Sortable list" });
    expect(list.getAttribute("data-orientation")).toBe("vertical");
    expect(list.querySelectorAll("[role=listitem]")).toHaveLength(0);
  });

  it("falls back to positional keys for missing or repeated ids", () => {
    render(
      untyped("SortableList", {
        items: [{ id: "x" }, { id: "x" }, { name: "Named" }],
        renderItem: (_item: unknown, state: { index: number }) => `row ${state.index}`,
        "aria-label": "Rows",
      })
    );
    const list = screen.getByRole("list", { name: "Rows" });
    expect(rowTexts(list)).toEqual(["row 0", "row 1", "row 2"]);
  });

  it("lays out horizontally", () => {
    render(
      createElement(kit.SortableList<Task>, {
        items: TASKS,
        "aria-label": "Tabs",
        orientation: "horizontal",
        renderItem: (item) => item.title,
      })
    );
    const list = screen.getByRole("list", { name: "Tabs" });
    expect(list.getAttribute("data-orientation")).toBe("horizontal");
    const alpha = handles()[0]!;
    alpha.focus();
    fireEvent.keyDown(alpha, { key: "ArrowRight" });
    expect(document.activeElement?.textContent).toBe("Bravo");
  });
});

describe("SortableList pointer drag", () => {
  // jsdom lays nothing out: rows are 20px tall, stacked from y=0, and the list
  // covers them.
  function stubLayout() {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement
    ) {
      const row = this.closest("[role=listitem]");
      const list = this.closest("[role=list]");
      if (row && list) {
        const index = [...list.children]
          .filter((c) => c.getAttribute("role") === "listitem")
          .indexOf(row);
        return DOMRect.fromRect({ x: 0, y: index * 20, width: 200, height: 20 });
      }
      if (list) return DOMRect.fromRect({ x: 0, y: 0, width: 200, height: 60 });
      return DOMRect.fromRect({ x: 0, y: 0, width: 800, height: 600 });
    });
  }

  it("leaves a placeholder, draws the drop line and reorders on release", async () => {
    stubLayout();
    const onReorder = vi.fn();
    render(
      createElement(kit.SortableList<Task>, {
        items: TASKS,
        "aria-label": "Priorities",
        renderItem: (item) => item.title,
        onReorder,
      })
    );
    const alpha = handles()[0]!;
    fireEvent.mouseDown(alpha, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.mouseMove(document, { clientX: 10, clientY: 25 });
    act(() => {
      fireEvent.mouseMove(window, { clientX: 10, clientY: 55 });
    });
    const placeholder = document.querySelector("[data-state=placeholder]");
    expect(placeholder?.textContent).toBe("Alpha");
    const line = document.querySelector("[data-kit-drop-indicator]");
    expect(line?.getAttribute("data-kit-drop-indicator")).toBe("after");
    expect(line?.closest("[role=listitem]")?.textContent).toBe("Charlie");
    expect(document.querySelector("[data-kit-drag-overlay]")?.textContent).toBe("Alpha");
    expect(liveText()).toContain("Alpha, position 3 of 3.");
    act(() => {
      fireEvent.mouseUp(document, { clientX: 10, clientY: 55 });
    });
    expect(onReorder).toHaveBeenCalledWith(0, 2);
    // dnd-kit swallows clicks for 50ms after a drop; let that lapse so it
    // doesn't eat the next test's.
    await act(() => new Promise((resolve) => setTimeout(resolve, CLICK_GUARD_LAPSE_MS)));
  });

  it("does not start from a press on a control inside the row", () => {
    stubLayout();
    const onReorder = vi.fn();
    render(
      createElement(kit.SortableList<Task>, {
        items: TASKS,
        "aria-label": "Priorities",
        renderItem: (item) => createElement("button", { type: "button" }, item.title),
        onReorder,
      })
    );
    const button = element(screen.getByText("Alpha").closest("button"));
    fireEvent.mouseDown(button, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.mouseMove(document, { clientX: 10, clientY: 55 });
    expect(document.querySelector("[data-state=placeholder]")).toBeNull();
    fireEvent.mouseUp(document);
    expect(onReorder).not.toHaveBeenCalled();
  });
});

interface Card {
  id: string;
  title: string;
}

const COLUMNS = [
  { id: "todo", title: "Backlog" },
  { id: "doing", title: "In progress", limit: 1 },
  { id: "review", title: "Review", empty: "Nothing to review" },
  { id: "done", title: "Done" },
];

const CARDS: Record<string, Card[]> = {
  todo: [
    { id: "t1", title: "Login redirect" },
    { id: "t2", title: "Rate limits" },
  ],
  doing: [
    { id: "d1", title: "Search index" },
    { id: "d2", title: "Cache warmup" },
  ],
  done: [{ id: "x1", title: "Release notes" }],
};

describe("Kanban", () => {
  function Board(props: {
    onMove?: (move: kit.KanbanMove) => void;
    collapsible?: boolean;
    defaultCollapsedColumns?: string[];
  }) {
    return withTooltips(
      createElement(kit.Kanban<Card>, {
        columns: COLUMNS,
        cards: CARDS,
        "aria-label": "Sprint board",
        renderCard: (card) => card.title,
        onMove: props.onMove,
        collapsible: props.collapsible,
        defaultCollapsedColumns: props.defaultCollapsedColumns,
        columnActions: (column) =>
          createElement("button", { type: "button" }, `Add to ${column.title}`),
      })
    );
  }

  function column(title: string): HTMLElement {
    return element(screen.getByRole("heading", { name: title }).closest("section"));
  }

  it("draws columns with headers, counts, limits and an empty state", () => {
    render(createElement(Board));
    expect(screen.getByRole("group", { name: "Sprint board" })).toBeTruthy();
    expect(screen.getAllByRole("heading").map((h) => h.textContent)).toEqual([
      "Backlog",
      "In progress",
      "Review",
      "Done",
    ]);
    const doing = column("In progress");
    const count = element(doing.querySelector("[data-kit-column-count]"));
    expect(count.hasAttribute("data-over-limit")).toBe(true);
    expect(count.textContent).toContain("2/1");
    expect(count.textContent).toContain("2 cards of a limit of 1, over the limit");
    expect(column("Backlog").querySelector("[data-over-limit]")).toBeNull();
    expect(column("Review").textContent).toContain("Nothing to review");
    expect(screen.getByRole("button", { name: "Add to Done" })).toBeTruthy();
    expect(
      screen.getByRole("list", { name: "Backlog" }).querySelectorAll("[role=listitem]")
    ).toHaveLength(2);
  });

  it("moves a card to the next column with Right and drops it", () => {
    const onMove = vi.fn();
    render(createElement(Board, { onMove }));
    const card = handles().find((h) => h.textContent === "Rate limits")!;
    card.focus();
    fireEvent.keyDown(card, { key: " " });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(liveText()).toContain("Rate limits, position 2 of 3 in In progress");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(liveText()).toContain("position 1 of 1 in Review");
    expect(column("Review").textContent).toContain("Rate limits");
    fireEvent.keyDown(document.activeElement!, { key: " " });
    expect(onMove).toHaveBeenCalledWith({
      cardId: "t2",
      fromColumn: "todo",
      toColumn: "review",
      fromIndex: 1,
      index: 0,
    });
  });

  it("reorders within a column with Up and Down", () => {
    const onMove = vi.fn();
    render(createElement(Board, { onMove }));
    const card = handles().find((h) => h.textContent === "Cache warmup")!;
    card.focus();
    fireEvent.keyDown(card, { key: " " });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    expect(onMove).toHaveBeenCalledWith({
      cardId: "d2",
      fromColumn: "doing",
      toColumn: "doing",
      fromIndex: 1,
      index: 0,
    });
  });

  it("moves focus across columns, skipping empty ones", () => {
    render(createElement(Board));
    const card = handles().find((h) => h.textContent === "Search index")!;
    card.focus();
    fireEvent.keyDown(card, { key: "ArrowRight" });
    expect(document.activeElement?.textContent).toBe("Release notes");
  });

  it("folds a column to a strip that still counts its cards", () => {
    render(createElement(Board, { collapsible: true }));
    fireEvent.click(screen.getByRole("button", { name: "Collapse Backlog" }));
    const strip = column("Backlog");
    expect(strip.getAttribute("data-state")).toBe("collapsed");
    expect(strip.textContent).toContain("2");
    expect(strip.querySelectorAll("[role=listitem]")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Expand Backlog" }));
    expect(column("Backlog").getAttribute("data-state")).toBeNull();
  });

  it("skips a folded column when a card moves by keyboard", () => {
    const onMove = vi.fn();
    render(createElement(Board, { onMove, collapsible: true, defaultCollapsedColumns: ["doing"] }));
    const card = handles().find((h) => h.textContent === "Login redirect")!;
    card.focus();
    fireEvent.keyDown(card, { key: " " });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    fireEvent.keyDown(document.activeElement!, { key: " " });
    expect(onMove).toHaveBeenCalledWith(expect.objectContaining({ toColumn: "review", index: 0 }));
  });

  it("degrades on untyped props", () => {
    expect(() =>
      render(
        withTooltips(
          untyped("Kanban", {
            columns: [
              null,
              { id: "" },
              { id: "a", title: 4, limit: -2 },
              { id: "a", title: "Dup" },
            ],
            cards: { a: "nope", constructor: [] },
            renderCard: "x",
            columnWidth: 9999,
          })
        )
      )
    ).not.toThrow();
    expect(screen.getAllByRole("heading").map((h) => h.textContent)).toEqual(["a"]);
    const section = element(screen.getByRole("heading", { name: "a" }).closest("section"));
    expect(section.style.width).toBe("480px");
    expect(section.textContent).toContain("No cards");
    expect(section.querySelector("[data-over-limit]")).toBeNull();
  });
});

describe("DragDropProvider, useDraggable and useDroppable", () => {
  function Item({ id }: { id: string }) {
    const drag = kit.useDraggable({ id });
    return createElement(
      "div",
      { ref: drag.ref, style: drag.style, "data-testid": `item-${id}` },
      createElement("span", { ...drag.handleProps, "data-testid": `handle-${id}` }, id)
    );
  }
  function Target({ id }: { id: string }) {
    const drop = kit.useDroppable({ id });
    return createElement("div", { ref: drop.ref, "data-over": drop.isOver ? "" : undefined }, id);
  }

  it("gives a draggable a focusable handle inside a provider", () => {
    render(
      createElement(
        kit.DragDropProvider,
        { getLabel: (id) => `Task ${String(id)}` },
        createElement(Item, { id: "a" }),
        createElement(Target, { id: "bin" })
      )
    );
    const handle = screen.getByTestId("handle-a");
    expect(handle.getAttribute("role")).toBe("button");
    expect(handle.tabIndex).toBe(0);
    expect(handle.getAttribute("aria-roledescription")).toBe("draggable");
    expect(handle.getAttribute("aria-disabled")).toBe("false");
    expect(handle.getAttribute("aria-pressed")).toBe("false");
    expect(handle.closest("[data-no-dnd]")).toBeTruthy();
  });

  it("disables a draggable with no provider", () => {
    render(createElement(Item, { id: "a" }));
    const handle = screen.getByTestId("handle-a");
    expect(handle.getAttribute("aria-disabled")).toBe("true");
    expect(handle.tabIndex).toBe(-1);
  });

  it("picks up with Space and reports the drag", async () => {
    const onDragStart = vi.fn();
    const onDragCancel = vi.fn();
    render(
      createElement(
        kit.DragDropProvider,
        { onDragStart, onDragCancel, renderOverlay: (id) => `Moving ${String(id)}` },
        createElement(Item, { id: "a" }),
        createElement(Target, { id: "bin" })
      )
    );
    const handle = screen.getByTestId("handle-a");
    handle.focus();
    act(() => {
      fireEvent.keyDown(handle, { code: "Space", key: " " });
    });
    expect(onDragStart).toHaveBeenCalledWith({ activeId: "a", overId: null });
    expect(screen.getByTestId("item-a").style.opacity).toBe("0.4");
    // dnd-kit starts listening for the held keys a tick after pickup.
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    act(() => {
      fireEvent.keyDown(handle, { code: "Escape", key: "Escape" });
    });
    expect(onDragCancel).toHaveBeenCalledWith({ activeId: "a", overId: null });
  });

  it("jumps between drop targets with the arrow keys", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement
    ) {
      const y = this.textContent === "bin" ? 200 : 0;
      return DOMRect.fromRect({ x: 0, y, width: 100, height: 40 });
    });
    const onDragEnd = vi.fn();
    render(
      createElement(
        kit.DragDropProvider,
        { onDragEnd },
        createElement(Item, { id: "a" }),
        createElement(Target, { id: "bin" })
      )
    );
    const handle = screen.getByTestId("handle-a");
    handle.focus();
    act(() => {
      fireEvent.keyDown(handle, { code: "Space", key: " " });
    });
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    act(() => {
      fireEvent.keyDown(handle, { code: "ArrowDown", key: "ArrowDown" });
    });
    act(() => {
      fireEvent.keyDown(handle, { code: "Space", key: " " });
    });
    expect(onDragEnd).toHaveBeenCalledWith({ activeId: "a", overId: "bin" });
  });

  it("stays inert outside a provider, even under another drag context", () => {
    function Probe() {
      const drag = kit.useDraggable({ id: "a" });
      const drop = kit.useDroppable({ id: "bin" });
      return createElement(
        "div",
        { ref: drop.ref, "data-over": String(drop.isOver), "data-active": String(drop.activeId) },
        createElement("span", { ...drag.handleProps, "data-testid": "probe" }, "a")
      );
    }
    render(createElement(DndContext, null, createElement(Probe)));
    const handle = screen.getByTestId("probe");
    expect(handle.getAttribute("aria-disabled")).toBe("true");
    expect(handle.parentElement?.getAttribute("data-active")).toBe("null");
  });

  it("ignores untyped options", () => {
    function Loose() {
      const drag = kit.useDraggable(Reflect.get({}, "x"));
      const drop = kit.useDroppable(Reflect.get({}, "x"));
      return createElement("div", { ref: drop.ref }, createElement("span", drag.handleProps, "x"));
    }
    render(untyped("DragDropProvider", { className: 3 }, createElement(Loose)));
    expect(screen.getByRole("button").getAttribute("aria-disabled")).toBe("true");
  });
});

describe("drag presentation rules", () => {
  it("puts the lifted copy beside the pointer, never over it", () => {
    const rect = { left: 100, top: 100, width: 200, height: 40 };
    const view = document.createElement("div");
    vi.spyOn(view, "getBoundingClientRect").mockReturnValue(
      DOMRect.fromRect({ x: 0, y: 0, width: 1000, height: 800 })
    );
    const room = besideCursor({ x: 300, y: 400 }, rect, view)!;
    expect(rect.left + room.x).toBeGreaterThan(300);
    // No room to the right: it flips left of the pointer instead.
    const edge = besideCursor({ x: 900, y: 400 }, rect, view)!;
    expect(rect.left + edge.x + rect.width).toBeLessThan(900);
    // And it never leaves the view.
    const corner = besideCursor({ x: 990, y: 790 }, rect, view)!;
    expect(rect.left + corner.x + rect.width).toBeLessThanOrEqual(1000);
    expect(rect.top + corner.y + rect.height).toBeLessThanOrEqual(800);
  });

  it("auto-scrolls a scroller only while the pointer holds near its edge", () => {
    const scroller = document.createElement("div");
    scroller.style.overflowY = "auto";
    scroller.style.overflowX = "auto";
    Object.defineProperty(scroller, "scrollHeight", { value: 2000 });
    Object.defineProperty(scroller, "clientHeight", { value: 400 });
    Object.defineProperty(scroller, "scrollWidth", { value: 2000 });
    Object.defineProperty(scroller, "clientWidth", { value: 400 });
    vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue(
      DOMRect.fromRect({ x: 0, y: 0, width: 400, height: 400 })
    );
    document.body.append(scroller);
    Object.defineProperty(document, "elementsFromPoint", {
      configurable: true,
      value: () => [scroller],
    });
    try {
      edgeScroll({ x: 200, y: 200 }, false, document.body);
      expect(scroller.scrollTop).toBe(0);
      expect(scroller.scrollLeft).toBe(0);
      edgeScroll({ x: 200, y: 395 }, false, document.body);
      expect(scroller.scrollTop).toBeGreaterThan(0);
      expect(scroller.scrollLeft).toBe(0);
      edgeScroll({ x: 395, y: 200 }, false, document.body);
      // A scroller outside the drag's own view never scrolls, however near its edge.
      const view = document.createElement("section");
      document.body.append(view);
      const before = scroller.scrollTop;
      edgeScroll({ x: 200, y: 395 }, false, view);
      expect(scroller.scrollTop).toBe(before);
      view.remove();
      expect(scroller.scrollLeft).toBeGreaterThan(0);
    } finally {
      Reflect.deleteProperty(document, "elementsFromPoint");
      scroller.remove();
    }
  });

  it("draws the lifted copy with no hover state", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement
    ) {
      const row = this.closest("[role=listitem]");
      const list = this.closest("[role=list]");
      if (row && list) {
        const index = [...list.children].indexOf(row);
        return DOMRect.fromRect({ x: 0, y: index * 20, width: 200, height: 20 });
      }
      return DOMRect.fromRect({ x: 0, y: 0, width: 200, height: 60 });
    });
    render(
      createElement(kit.SortableList<Task>, {
        items: TASKS,
        "aria-label": "Priorities",
        renderItem: (item) => item.title,
      })
    );
    const alpha = handles()[0]!;
    fireEvent.mouseDown(alpha, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.mouseMove(document, { clientX: 10, clientY: 25 });
    const copy = element(document.querySelector("[data-kit-drag-overlay]"));
    const classes = [copy, ...copy.querySelectorAll("*")].flatMap((el) =>
      (el.getAttribute("class") ?? "").split(/\s+/)
    );
    expect(classes.filter((name) => name.startsWith("hover:"))).toEqual([]);
    act(() => {
      fireEvent.mouseUp(document);
    });
    await act(() => new Promise((resolve) => setTimeout(resolve, CLICK_GUARD_LAPSE_MS)));
  });
});

describe("moves without dragging", () => {
  beforeEach(() => {
    // Radix menus measure their content; jsdom has no ResizeObserver.
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function openMenu(target: HTMLElement) {
    fireEvent.contextMenu(target, { button: 2, clientX: 5, clientY: 5 });
  }

  it("reorders a list row from its context menu", () => {
    const onReorder = vi.fn();
    render(
      withTooltips(
        createElement(kit.SortableList<Task>, {
          items: TASKS,
          "aria-label": "Priorities",
          renderItem: (item) => item.title,
          onReorder,
        })
      )
    );
    openMenu(handles()[0]!);
    expect(screen.getByRole("menuitem", { name: "Move up" }).getAttribute("aria-disabled")).toBe(
      "true"
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Move down" }));
    expect(onReorder).toHaveBeenCalledWith(0, 1);
    expect(liveText()).toContain("Moved Alpha to position 2 of 3");
  });

  it("moves a card to another column from its context menu", () => {
    const onMove = vi.fn();
    render(
      withTooltips(
        createElement(kit.Kanban<Card>, {
          columns: COLUMNS,
          cards: CARDS,
          "aria-label": "Sprint board",
          renderCard: (card) => card.title,
          onMove,
        })
      )
    );
    openMenu(handles().find((h) => h.textContent === "Rate limits")!);
    fireEvent.click(screen.getByRole("menuitem", { name: "Move to Review" }));
    expect(onMove).toHaveBeenCalledWith({
      cardId: "t2",
      fromColumn: "todo",
      toColumn: "review",
      fromIndex: 1,
      index: 0,
    });
  });
});

describe("menu moves into a folded column", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("unfolds the column the card was moved into", () => {
    const onMove = vi.fn();
    render(
      withTooltips(
        createElement(kit.Kanban<Card>, {
          columns: COLUMNS,
          cards: CARDS,
          "aria-label": "Sprint board",
          renderCard: (card) => card.title,
          collapsible: true,
          defaultCollapsedColumns: ["done"],
          onMove,
        })
      )
    );
    const done = () => element(screen.getByRole("heading", { name: "Done" }).closest("section"));
    expect(done().getAttribute("data-state")).toBe("collapsed");
    fireEvent.contextMenu(
      handles().find((h) => h.textContent === "Rate limits")!,
      {
        button: 2,
        clientX: 5,
        clientY: 5,
      }
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Move to Done" }));
    expect(onMove).toHaveBeenCalledWith(expect.objectContaining({ toColumn: "done", index: 1 }));
    expect(done().getAttribute("data-state")).toBeNull();
  });
});

describe("items under a pointer drag", () => {
  it("drop their own hover treatment while one is held", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement
    ) {
      const row = this.closest("[role=listitem]");
      const list = this.closest("[role=list]");
      if (row && list) {
        const index = [...list.children].indexOf(row);
        return DOMRect.fromRect({ x: 0, y: index * 20, width: 200, height: 20 });
      }
      return DOMRect.fromRect({ x: 0, y: 0, width: 200, height: 60 });
    });
    render(
      createElement(kit.SortableList<Task>, {
        items: TASKS,
        "aria-label": "Priorities",
        renderItem: (item) => item.title,
      })
    );
    const surfaces = () =>
      [...document.querySelectorAll("[role=list] > [role=listitem] > *")].map(
        (el) => el.getAttribute("class") ?? ""
      );
    expect(surfaces().some((names) => names.includes("hover:"))).toBe(true);
    fireEvent.mouseDown(handles()[0]!, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.mouseMove(document, { clientX: 10, clientY: 25 });
    expect(surfaces().filter((names) => names.includes("hover:"))).toEqual([]);
    act(() => {
      fireEvent.mouseUp(document);
    });
    await act(() => new Promise((resolve) => setTimeout(resolve, CLICK_GUARD_LAPSE_MS)));
  });
});

describe("keyboard previews", () => {
  it("hands renderItem the index the held item is drawn at", () => {
    render(
      createElement(kit.SortableList<Task>, {
        items: TASKS,
        "aria-label": "Priorities",
        renderItem: (item, { index }) => `${index + 1}. ${item.title}`,
      })
    );
    const list = screen.getByRole("list", { name: "Priorities" });
    const alpha = handles()[0]!;
    alpha.focus();
    fireEvent.keyDown(alpha, { key: " " });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(rowTexts(list)).toEqual(["1. Bravo", "2. Alpha", "3. Charlie"]);
  });

  it("counts a column's cards as drawn while one is held over it", () => {
    render(
      withTooltips(
        createElement(kit.Kanban<Card>, {
          columns: COLUMNS,
          cards: CARDS,
          "aria-label": "Sprint board",
          renderCard: (card) => card.title,
        })
      )
    );
    const count = (title: string) =>
      element(
        screen
          .getByRole("heading", { name: title })
          .closest("section")
          ?.querySelector("[data-kit-column-count] span[aria-hidden]")
      ).textContent;
    const card = handles().find((h) => h.textContent === "Rate limits")!;
    card.focus();
    fireEvent.keyDown(card, { key: " " });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(count("Backlog")).toBe("1");
    expect(count("In progress")).toBe("3/1");
  });
});

describe("empty column as a drop target", () => {
  it("arms the whole column and draws no insertion line", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement
    ) {
      const section = this.closest("section");
      const columns = [...document.querySelectorAll("section")];
      const at = section ? columns.indexOf(section) : 0;
      const row = this.closest("[role=listitem]");
      if (row) {
        const index = [...(row.parentElement?.children ?? [])].indexOf(row);
        return DOMRect.fromRect({ x: at * 300, y: 40 + index * 50, width: 280, height: 44 });
      }
      return DOMRect.fromRect({ x: at * 300, y: 0, width: 280, height: 600 });
    });
    render(
      withTooltips(
        createElement(kit.Kanban<Card>, {
          columns: COLUMNS,
          cards: CARDS,
          "aria-label": "Sprint board",
          renderCard: (card) => card.title,
        })
      )
    );
    const card = handles().find((h) => h.textContent === "Rate limits")!;
    fireEvent.mouseDown(card, { button: 0, clientX: 20, clientY: 100 });
    fireEvent.mouseMove(document, { clientX: 40, clientY: 110 });
    act(() => {
      fireEvent.mouseMove(window, { clientX: 700, clientY: 300 });
    });
    const review = element(screen.getByRole("heading", { name: "Review" }).closest("section"));
    expect(review.getAttribute("data-drop-target")).toBe("true");
    expect(review.querySelector("[data-kit-drop-indicator]")).toBeNull();
    act(() => {
      fireEvent.keyDown(document, { key: "Escape", code: "Escape" });
      fireEvent.mouseUp(document);
    });
    await act(() => new Promise((resolve) => setTimeout(resolve, CLICK_GUARD_LAPSE_MS)));
  });
});
