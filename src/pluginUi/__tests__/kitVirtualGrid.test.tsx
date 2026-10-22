// @vitest-environment jsdom
import {
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  VirtuosoMockContext,
  type ListItem,
  type VirtuosoHandle,
  type VirtuosoProps,
} from "react-virtuoso";

// jsdom lays nothing out, so Virtuoso never scrolls there. The grid's props to
// it and its scroll requests are recorded, passing through unchanged, except
// for the rendered rows: those come from the test alone, as Virtuoso would
// report them after a scroll, so no mock-context guess competes with them.
interface RecordedProps {
  itemsRendered: ((items: ListItem<unknown>[]) => void) | undefined;
  totalCount: number | undefined;
  defaultItemHeight: number | undefined;
  increaseViewportBy: unknown;
}

const virtuoso = vi.hoisted(() => ({
  props: new Array<RecordedProps>(),
  scrolls: new Array<number>(),
}));

vi.mock("react-virtuoso", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-virtuoso")>();
  function RecordingVirtuoso({
    ref,
    itemsRendered,
    ...rest
  }: VirtuosoProps<unknown, unknown> & { ref?: Ref<VirtuosoHandle> }) {
    const inner = useRef<VirtuosoHandle>(null);
    useLayoutEffect(() => {
      virtuoso.props.push({
        itemsRendered,
        totalCount: rest.totalCount,
        defaultItemHeight: rest.defaultItemHeight,
        increaseViewportBy: rest.increaseViewportBy,
      });
    });
    useImperativeHandle(ref, () => ({
      scrollToIndex: (location) => inner.current?.scrollToIndex(location),
      scrollIntoView: (location) => {
        virtuoso.scrolls.push(location.index);
        inner.current?.scrollIntoView(location);
      },
      scrollTo: (location) => inner.current?.scrollTo(location),
      scrollBy: (location) => inner.current?.scrollBy(location),
      getState: (callback) => inner.current?.getState(callback),
      autoscrollToBottom: () => inner.current?.autoscrollToBottom(),
    }));
    return <actual.Virtuoso {...rest} ref={inner} />;
  }
  return { ...actual, Virtuoso: RecordingVirtuoso };
});

const lastProps = (): RecordedProps => virtuoso.props[virtuoso.props.length - 1]!;

/** Reports the rows Virtuoso has mounted, as it would after a scroll; none when `end` is before `start`. */
function mountedRows(start: number, end: number) {
  const rows: ListItem<unknown>[] = [];
  for (let index = start; index <= end; index++)
    rows.push({ index, offset: index * 100, size: 100 });
  act(() => lastProps().itemsRendered?.(rows));
}

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn(() => Promise.resolve()) },
}));

import * as kit from "@daintreehq/plugin-ui";
import { gridColumns, gridStep } from "@/components/PluginKit/PluginKitVirtualGrid";

// A ResizeObserver that reports when the test says the layout changed, with
// an entry per observed element: Virtuoso's own observers read the target.
const resizeCallbacks = new Set<() => void>();
class ManualResizeObserver {
  private readonly targets = new Set<Element>();
  private readonly callback: () => void;
  constructor(callback: (entries: { target: Element }[]) => void) {
    this.callback = () => {
      if (this.targets.size > 0) callback([...this.targets].map((target) => ({ target })));
    };
  }
  observe(target: Element) {
    this.targets.add(target);
    resizeCallbacks.add(this.callback);
  }
  unobserve(target: Element) {
    this.targets.delete(target);
  }
  disconnect() {
    this.targets.clear();
    resizeCallbacks.delete(this.callback);
  }
}

// jsdom lays nothing out: the grid's scroller is as wide as the test says.
let scrollerWidth = 0;
function resizeTo(width: number) {
  scrollerWidth = width;
  act(() => {
    for (const callback of [...resizeCallbacks]) callback();
  });
}

beforeAll(async () => {
  await kit.whenPluginUiReady();
}, 60_000);

beforeEach(() => {
  scrollerWidth = 400;
  vi.stubGlobal("ResizeObserver", ManualResizeObserver);
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.hasAttribute("data-virtuoso-scroller") ? scrollerWidth : 0;
    },
  });
});

afterEach(() => {
  cleanup();
  virtuoso.props.length = 0;
  virtuoso.scrolls.length = 0;
  resizeCallbacks.clear();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
});

function mount(element: ReactNode, rowHeight = 100) {
  return render(
    <VirtuosoMockContext.Provider value={{ viewportHeight: 600, itemHeight: rowHeight }}>
      <div style={{ height: 600 }}>{element}</div>
    </VirtuosoMockContext.Provider>
  );
}

interface Photo {
  id: string;
  title: string;
}

const photos = (n: number): Photo[] =>
  Array.from({ length: n }, (_, index) => ({ id: `p${index}`, title: `Photo ${index}` }));

function rowsOf(container: HTMLElement): string[][] {
  return [...container.querySelectorAll("[data-index]")].map((row) =>
    [...row.children].map((cell) => cell.textContent ?? "")
  );
}

function activeTitle(grid: HTMLElement): string | null {
  const id = grid.getAttribute("aria-activedescendant");
  return id ? (document.getElementById(id)?.textContent ?? null) : null;
}

function selectedTitles(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[role="gridcell"][aria-selected="true"]')].map(
    (cell) => cell.textContent ?? ""
  );
}

describe("gridColumns", () => {
  it("fits as many columns as the width holds at the minimum, gaps included", () => {
    // Two 180 px columns and a 12 px gap need exactly 372 px.
    expect(gridColumns(371, 180, undefined, 12)).toBe(1);
    expect(gridColumns(372, 180, undefined, 12)).toBe(2);
    expect(gridColumns(1000, 180, undefined, 12)).toBe(5);
    expect(gridColumns(1000, 180, undefined, 0)).toBe(5);
    expect(gridColumns(1000, 240, undefined, 0)).toBe(4);
  });

  it("never draws columns narrower than its floor, whatever the minimum asked", () => {
    const floor = gridColumns(1000, 16, undefined, 0);
    expect(gridColumns(1000, 1, undefined, 0)).toBe(floor);
    expect(gridColumns(1000, 0.5, undefined, 0)).toBe(floor);
    expect(gridColumns(1000, 17, undefined, 0)).toBeLessThan(floor);
  });

  it("caps at maxColumns and draws one column until measured", () => {
    expect(gridColumns(2000, 180, 3, 12)).toBe(3);
    expect(gridColumns(200, 180, 3, 12)).toBe(1);
    expect(gridColumns(0, 180, undefined, 12)).toBe(1);
    expect(gridColumns(100, 180, undefined, 12)).toBe(1);
  });

  it("falls back to the default minimum and ignores a cap that is not a whole count", () => {
    const fallback = gridColumns(1000, undefined, undefined, 12);
    for (const bad of [0, -5, 5000, Number.NaN, "wide"]) {
      expect(gridColumns(1000, bad, undefined, 12)).toBe(fallback);
    }
    for (const bad of [0, -1, 2.5, "3"]) {
      expect(gridColumns(1000, 180, bad, 12)).toBe(gridColumns(1000, 180, undefined, 12));
    }
  });
});

describe("gridStep", () => {
  // 10 items in 4 columns:  0 1 2 3 / 4 5 6 7 / 8 9
  const step = (key: string, from: number, wide = false) => gridStep(key, from, 10, 4, wide);

  it("steps Left and Right in reading order, stopping at the ends", () => {
    expect(step("ArrowRight", 3)).toBe(4);
    expect(step("ArrowLeft", 4)).toBe(3);
    expect(step("ArrowLeft", 0)).toBe(0);
    expect(step("ArrowRight", 9)).toBe(9);
  });

  it("keeps the column Up and Down, landing on the last item of a short last row", () => {
    expect(step("ArrowDown", 1)).toBe(5);
    expect(step("ArrowDown", 5)).toBe(9);
    expect(step("ArrowDown", 6)).toBe(9);
    expect(step("ArrowDown", 9)).toBe(9);
    expect(step("ArrowUp", 9)).toBe(5);
    expect(step("ArrowUp", 2)).toBe(2);
  });

  it("goes to the row's ends with Home and End, and the grid's with Ctrl or Cmd", () => {
    expect(step("Home", 6)).toBe(4);
    expect(step("End", 4)).toBe(7);
    expect(step("End", 8)).toBe(9);
    expect(step("Home", 6, true)).toBe(0);
    expect(step("End", 2, true)).toBe(9);
  });

  it("is not navigation for other keys, modified arrows or an empty grid", () => {
    expect(step("a", 0)).toBeNull();
    expect(step("ArrowRight", 0, true)).toBeNull();
    expect(gridStep("ArrowRight", 0, 0, 4, false)).toBeNull();
  });
});

describe("VirtualGrid", () => {
  it("lays the cards out in as many columns as the measured width holds", () => {
    const { container } = mount(
      <kit.VirtualGrid
        aria-label="Photos"
        items={photos(5)}
        itemKey={(_index, photo) => photo.id}
        renderItem={(_index, photo) => photo.title}
      />
    );
    expect(screen.getByRole("list", { name: "Photos" })).toBeTruthy();
    expect(rowsOf(container)).toEqual([
      ["Photo 0", "Photo 1"],
      ["Photo 2", "Photo 3"],
      ["Photo 4"],
    ]);
    expect(screen.getAllByRole("listitem")).toHaveLength(5);

    resizeTo(800);
    expect(rowsOf(container)).toEqual([["Photo 0", "Photo 1", "Photo 2", "Photo 3"], ["Photo 4"]]);

    // A pane that is hidden reads no width and keeps its columns.
    resizeTo(0);
    expect(rowsOf(container)).toHaveLength(2);

    resizeTo(2000);
    expect(rowsOf(container)).toHaveLength(1);
  });

  it("honours minColumnWidth and maxColumns", () => {
    const { container } = mount(
      <kit.VirtualGrid
        aria-label="Photos"
        count={6}
        minColumnWidth={90}
        maxColumns={3}
        gap="none"
        renderItem={(index) => `#${index}`}
      />
    );
    expect(rowsOf(container)).toEqual([
      ["#0", "#1", "#2"],
      ["#3", "#4", "#5"],
    ]);
  });

  it("mounts only the rows in view of ten thousand cards", () => {
    const seen = new Set<number>();
    mount(
      <kit.VirtualGrid
        aria-label="Photos"
        count={10_000}
        renderItem={(index) => {
          seen.add(index);
          return `#${index}`;
        }}
      />
    );
    const mounted = screen.getAllByRole("listitem").length;
    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThan(100);
    expect(seen.has(9_999)).toBe(false);
  });

  it("is a keyboard grid that moves its cursor in two dimensions and keeps it through a regroup", () => {
    mount(
      <kit.VirtualGrid
        aria-label="Photos"
        items={photos(10)}
        itemKey={(_index, photo) => photo.id}
        onItemActivate={() => {}}
        renderItem={(_index, photo) => photo.title}
      />
    );
    const grid = screen.getByRole("grid", { name: "Photos" });
    expect(grid.getAttribute("aria-colcount")).toBe("2");
    expect(grid.getAttribute("aria-rowcount")).toBe("5");
    act(() => grid.focus());
    expect(activeTitle(grid)).toBe("Photo 0");
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    expect(activeTitle(grid)).toBe("Photo 2");
    fireEvent.keyDown(grid, { key: "ArrowRight" });
    expect(activeTitle(grid)).toBe("Photo 3");
    fireEvent.keyDown(grid, { key: "End", ctrlKey: true });
    expect(activeTitle(grid)).toBe("Photo 9");
    fireEvent.keyDown(grid, { key: "Home" });
    expect(activeTitle(grid)).toBe("Photo 8");

    resizeTo(800);
    expect(grid.getAttribute("aria-colcount")).toBe("4");
    expect(grid.getAttribute("aria-rowcount")).toBe("3");
    expect(activeTitle(grid)).toBe("Photo 8");
    fireEvent.keyDown(grid, { key: "ArrowUp" });
    expect(activeTitle(grid)).toBe("Photo 4");

    const active = document.getElementById(grid.getAttribute("aria-activedescendant")!)!;
    expect(active.getAttribute("role")).toBe("gridcell");
    expect(active.getAttribute("aria-colindex")).toBe("1");
    expect(active.parentElement?.getAttribute("role")).toBe("row");
    expect(active.parentElement?.getAttribute("aria-rowindex")).toBe("2");
  });

  it("drives a useSelection result from clicks and keys", () => {
    const seen = new Map<string, boolean>();
    function Photos() {
      const items = photos(10);
      const selection = kit.useSelection({ ids: items.map((photo) => photo.id) });
      return (
        <kit.VirtualGrid
          aria-label="Photos"
          aria-multiselectable
          items={items}
          itemKey={(_index, photo) => photo.id}
          selection={selection}
          renderItem={(_index, photo, state) => {
            seen.set(photo.title, state.selected);
            return photo.title;
          }}
        />
      );
    }
    const { container } = mount(<Photos />);
    const grid = screen.getByRole("grid", { name: "Photos" });
    expect(grid.getAttribute("aria-multiselectable")).toBe("true");
    act(() => grid.focus());

    fireEvent.keyDown(grid, { key: "ArrowRight" });
    fireEvent.keyDown(grid, { key: " " });
    expect(selectedTitles(container)).toEqual(["Photo 1"]);
    expect(seen.get("Photo 1")).toBe(true);

    // Shift with an arrow extends from the anchor, in item order.
    fireEvent.keyDown(grid, { key: "ArrowDown", shiftKey: true });
    expect(selectedTitles(container)).toEqual(["Photo 1", "Photo 2", "Photo 3"]);

    fireEvent.keyDown(grid, { key: "a", ctrlKey: true });
    expect(selectedTitles(container)).toHaveLength(
      container.querySelectorAll('[role="gridcell"]').length
    );

    fireEvent.keyDown(grid, { key: "Escape" });
    expect(selectedTitles(container)).toEqual([]);

    fireEvent.click(screen.getByText("Photo 5"));
    expect(selectedTitles(container)).toEqual(["Photo 5"]);
    expect(activeTitle(grid)).toBe("Photo 5");
    fireEvent.click(screen.getByText("Photo 7"), { ctrlKey: true });
    expect(selectedTitles(container)).toEqual(["Photo 5", "Photo 7"]);
    expect(seen.get("Photo 1")).toBe(false);
  });

  it("starts a Shift range at the cursor when nothing is anchored yet", () => {
    function Photos() {
      const items = photos(6);
      const selection = kit.useSelection({ ids: items.map((photo) => photo.id) });
      return (
        <kit.VirtualGrid
          aria-label="Photos"
          items={items}
          itemKey={(_index, photo) => photo.id}
          selection={selection}
          renderItem={(_index, photo) => photo.title}
        />
      );
    }
    const { container } = mount(<Photos />);
    const grid = screen.getByRole("grid", { name: "Photos" });
    act(() => grid.focus());
    fireEvent.keyDown(grid, { key: "ArrowRight", shiftKey: true });
    expect(selectedTitles(container)).toEqual(["Photo 0", "Photo 1"]);
  });

  it("activates the cursor with Enter and a plain click, leaving modified clicks to the selection", () => {
    const onItemActivate = vi.fn();
    function Photos() {
      const items = photos(4);
      const selection = kit.useSelection({ ids: items.map((photo) => photo.id) });
      return (
        <kit.VirtualGrid
          aria-label="Photos"
          items={items}
          itemKey={(_index, photo) => photo.id}
          selection={selection}
          onItemActivate={onItemActivate}
          renderItem={(_index, photo) => (
            <>
              {photo.title}
              <button type="button">Share {photo.title}</button>
            </>
          )}
        />
      );
    }
    const { container } = mount(<Photos />);
    const grid = screen.getByRole("grid", { name: "Photos" });
    act(() => grid.focus());
    fireEvent.keyDown(grid, { key: "ArrowRight" });
    fireEvent.keyDown(grid, { key: "Enter" });
    expect(onItemActivate).toHaveBeenLastCalledWith(1, { id: "p1", title: "Photo 1" });

    fireEvent.click(document.getElementById(grid.getAttribute("aria-activedescendant")!)!, {
      shiftKey: true,
    });
    expect(onItemActivate).toHaveBeenCalledTimes(1);
    expect(selectedTitles(container)).toHaveLength(1);

    // A control inside the card keeps its own click.
    fireEvent.click(screen.getByRole("button", { name: "Share Photo 3" }));
    expect(onItemActivate).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getAllByRole("gridcell")[2]!);
    expect(onItemActivate).toHaveBeenLastCalledWith(2, { id: "p2", title: "Photo 2" });
  });

  it("follows a controlled cursor and reports where it moves, scrolling once per move", () => {
    const onActiveIndexChange = vi.fn();
    function Photos() {
      const [active, setActive] = useState(4);
      return (
        <kit.VirtualGrid
          aria-label="Photos"
          count={6}
          activeIndex={active}
          onActiveIndexChange={(index) => {
            onActiveIndexChange(index);
            setActive(index);
          }}
          onItemActivate={() => {}}
          renderItem={(index) => `#${index}`}
        />
      );
    }
    mount(<Photos />);
    const grid = screen.getByRole("grid", { name: "Photos" });
    expect(activeTitle(grid)).toBe("#4");
    virtuoso.scrolls.length = 0;
    fireEvent.keyDown(grid, { key: "ArrowUp" });
    expect(onActiveIndexChange).toHaveBeenLastCalledWith(2);
    expect(activeTitle(grid)).toBe("#2");
    // The key scrolled to the cursor's row; the echo of its report does not again.
    expect(virtuoso.scrolls).toEqual([1]);
  });

  it("keeps a plain grid's activeIndex in view as it changes, within a row too", () => {
    const grid = (active: number) => (
      <VirtuosoMockContext.Provider value={{ viewportHeight: 600, itemHeight: 100 }}>
        <div style={{ height: 600 }}>
          <kit.VirtualGrid
            aria-label="Photos"
            count={40}
            activeIndex={active}
            renderItem={(index) => `#${index}`}
          />
        </div>
      </VirtuosoMockContext.Provider>
    );
    const view = render(grid(30));
    // Item 30 of 40 in two columns is on row 15.
    expect(virtuoso.scrolls).toContain(15);
    virtuoso.scrolls.length = 0;
    view.rerender(grid(31));
    expect(virtuoso.scrolls).toEqual([15]);
  });

  it("drops aria-activedescendant while the cursor's row is scrolled out of the mounted rows", () => {
    mount(
      <kit.VirtualGrid
        aria-label="Photos"
        count={40}
        onItemActivate={() => {}}
        renderItem={(index) => `#${index}`}
      />
    );
    const grid = screen.getByRole("grid", { name: "Photos" });
    act(() => grid.focus());
    mountedRows(0, 8);
    expect(activeTitle(grid)).toBe("#0");
    mountedRows(6, 14);
    expect(grid.hasAttribute("aria-activedescendant")).toBe(false);
    // The next key brings the cursor's row back into view.
    virtuoso.scrolls.length = 0;
    fireEvent.keyDown(grid, { key: "ArrowRight" });
    expect(virtuoso.scrolls).toEqual([0]);
  });

  it("leaves a press to place the cursor, and still finds it from the keyboard", () => {
    const onItemActivate = vi.fn();
    mount(
      <kit.VirtualGrid
        aria-label="Photos"
        count={12}
        onItemActivate={onItemActivate}
        renderItem={(index) => `#${index}`}
      />
    );
    const grid = screen.getByRole("grid", { name: "Photos" });
    virtuoso.scrolls.length = 0;
    // A press between cards focuses the grid without a cursor or a scroll.
    fireEvent.pointerDown(grid);
    act(() => grid.focus());
    fireEvent.pointerUp(grid);
    expect(grid.hasAttribute("aria-activedescendant")).toBe(false);
    expect(virtuoso.scrolls).toEqual([]);
    // End keeps its destination even with no cursor yet; an arrow finds the first card.
    fireEvent.keyDown(grid, { key: "End", ctrlKey: true });
    expect(activeTitle(grid)).toBe("#11");

    // A press that never lands (a cancelled touch) does not hide the next focus.
    act(() => grid.blur());
    fireEvent.pointerDown(grid);
    fireEvent.pointerCancel(grid);
    act(() => grid.focus());
    expect(activeTitle(grid)).toBe("#11");

    fireEvent.click(screen.getByText("#3"));
    expect(activeTitle(grid)).toBe("#3");
    expect(onItemActivate).toHaveBeenLastCalledWith(3, undefined);
    fireEvent.keyDown(grid, { key: " " });
    expect(onItemActivate).toHaveBeenCalledTimes(2);
  });

  it("starts the keyboard on the first card when focus arrives from the keyboard", () => {
    mount(
      <kit.VirtualGrid
        aria-label="Photos"
        count={4}
        onItemActivate={() => {}}
        renderItem={(index) => `#${index}`}
      />
    );
    const grid = screen.getByRole("grid", { name: "Photos" });
    // A press that ended elsewhere: the grid's focus later is the keyboard's.
    fireEvent.pointerDown(grid);
    fireEvent.pointerCancel(grid);
    act(() => grid.focus());
    expect(activeTitle(grid)).toBe("#0");
  });

  it("clamps the cursor when the items shrink under it", () => {
    const grid = (n: number) => (
      <VirtuosoMockContext.Provider value={{ viewportHeight: 600, itemHeight: 100 }}>
        <div style={{ height: 600 }}>
          <kit.VirtualGrid
            aria-label="Photos"
            items={photos(n)}
            itemKey={(_index, photo) => photo.id}
            onItemActivate={() => {}}
            renderItem={(_index, photo) => photo.title}
          />
        </div>
      </VirtuosoMockContext.Provider>
    );
    const view = render(grid(10));
    const photoGrid = screen.getByRole("grid", { name: "Photos" });
    act(() => photoGrid.focus());
    fireEvent.keyDown(photoGrid, { key: "End", ctrlKey: true });
    expect(activeTitle(photoGrid)).toBe("Photo 9");
    view.rerender(grid(5));
    expect(activeTitle(photoGrid)).toBe("Photo 4");
  });

  it("reports the last item once per item count while the last row is mounted", () => {
    const onEndReached = vi.fn();
    const grid = (n: number) => (
      <VirtuosoMockContext.Provider value={{ viewportHeight: 600, itemHeight: 100 }}>
        <div style={{ height: 600 }}>
          <kit.VirtualGrid
            aria-label="Photos"
            items={photos(n)}
            itemKey={(_index, photo) => photo.id}
            onEndReached={onEndReached}
            renderItem={(_index, photo) => photo.title}
          />
        </div>
      </VirtuosoMockContext.Provider>
    );
    const view = render(grid(9));
    expect(lastProps().totalCount).toBe(5);
    expect(onEndReached).not.toHaveBeenCalled();
    mountedRows(0, 4);
    expect(onEndReached).toHaveBeenCalledTimes(1);
    expect(onEndReached).toHaveBeenLastCalledWith(8);

    // A page that only fills out the last row adds no row to report.
    view.rerender(grid(10));
    expect(lastProps().totalCount).toBe(5);
    expect(screen.getByText("Photo 9")).toBeTruthy();
    expect(onEndReached).toHaveBeenCalledTimes(2);
    expect(onEndReached).toHaveBeenLastCalledWith(9);

    // A regroup changes the rows, not the items: nothing new to load.
    resizeTo(800);
    mountedRows(0, 2);
    expect(onEndReached).toHaveBeenCalledTimes(2);

    // A page that adds rows waits for its last row to be mounted.
    view.rerender(grid(200));
    expect(onEndReached).toHaveBeenCalledTimes(2);
    mountedRows(42, 49);
    expect(onEndReached).toHaveBeenCalledTimes(3);
    expect(onEndReached).toHaveBeenLastCalledWith(199);

    // Emptied and filled again from the top: the same count is news, once
    // the end is mounted again, and not before.
    view.rerender(grid(0));
    mountedRows(0, -1);
    view.rerender(grid(200));
    mountedRows(0, 9);
    expect(onEndReached).toHaveBeenCalledTimes(3);
    mountedRows(42, 49);
    expect(onEndReached).toHaveBeenCalledTimes(4);
    expect(onEndReached).toHaveBeenLastCalledWith(199);

    // Grown without reaching the end, then back to a count already reported.
    view.rerender(grid(10));
    mountedRows(0, 2);
    view.rerender(grid(300));
    mountedRows(0, 9);
    view.rerender(grid(10));
    mountedRows(0, 2);
    expect(onEndReached).toHaveBeenLastCalledWith(9);
    expect(onEndReached).toHaveBeenCalledTimes(6);
  });

  it("does not report the end of ten thousand cards from the top", () => {
    const onEndReached = vi.fn();
    mount(
      <kit.VirtualGrid
        aria-label="Photos"
        count={10_000}
        onEndReached={onEndReached}
        renderItem={(index) => `#${index}`}
      />
    );
    mountedRows(0, 8);
    expect(onEndReached).not.toHaveBeenCalled();
  });

  it("sizes its rows from estimatedItemSize, gap and overscan", () => {
    mount(
      <kit.VirtualGrid
        aria-label="Photos"
        count={10}
        gap="none"
        estimatedItemSize={100}
        overscan={3}
        renderItem={(index) => `#${index}`}
      />
    );
    expect(lastProps().defaultItemHeight).toBe(100);
    expect(lastProps().increaseViewportBy).toBe(300);
  });

  it("reveals an activeIndex set while the grid is hidden once it shows again", () => {
    const grid = (active: number) => (
      <VirtuosoMockContext.Provider value={{ viewportHeight: 600, itemHeight: 100 }}>
        <div style={{ height: 600 }}>
          <kit.VirtualGrid
            aria-label="Photos"
            count={40}
            activeIndex={active}
            renderItem={(index) => `#${index}`}
          />
        </div>
      </VirtuosoMockContext.Provider>
    );
    const view = render(grid(0));
    resizeTo(0);
    virtuoso.scrolls.length = 0;
    view.rerender(grid(30));
    expect(virtuoso.scrolls).toEqual([]);
    resizeTo(400);
    // Item 30 of 40 in two columns is on row 15.
    expect(virtuoso.scrolls).toEqual([15]);
    // Shown again with nothing pending, it stays where it is.
    resizeTo(0);
    resizeTo(400);
    expect(virtuoso.scrolls).toEqual([15]);
  });

  it("does not scroll to a move a controlling plugin refuses", () => {
    const onActiveIndexChange = vi.fn();
    mount(
      <kit.VirtualGrid
        aria-label="Photos"
        count={40}
        activeIndex={0}
        onActiveIndexChange={onActiveIndexChange}
        onItemActivate={() => {}}
        renderItem={(index) => `#${index}`}
      />
    );
    const grid = screen.getByRole("grid", { name: "Photos" });
    virtuoso.scrolls.length = 0;
    fireEvent.keyDown(grid, { key: "End", ctrlKey: true });
    expect(onActiveIndexChange).toHaveBeenLastCalledWith(39);
    expect(activeTitle(grid)).toBe("#0");
    expect(virtuoso.scrolls).toEqual([]);
  });

  it("keeps the cursor's row in view through a regroup only while the grid has focus", () => {
    render(
      <VirtuosoMockContext.Provider value={{ viewportHeight: 600, itemHeight: 100 }}>
        <button type="button">Elsewhere</button>
        <div style={{ height: 600 }}>
          <kit.VirtualGrid
            aria-label="Photos"
            count={40}
            onItemActivate={() => {}}
            renderItem={(index) => `#${index}`}
          />
        </div>
      </VirtuosoMockContext.Provider>
    );
    const grid = screen.getByRole("grid", { name: "Photos" });
    act(() => grid.focus());
    fireEvent.keyDown(grid, { key: "End", ctrlKey: true });
    // Item 39 of 40 in two columns is on row 19.
    expect(virtuoso.scrolls).toContain(19);

    act(() => screen.getByRole("button", { name: "Elsewhere" }).focus());
    virtuoso.scrolls.length = 0;
    resizeTo(800);
    expect(virtuoso.scrolls).toEqual([]);

    act(() => grid.focus());
    virtuoso.scrolls.length = 0;
    resizeTo(400);
    // Two columns again: back on row 19.
    expect(virtuoso.scrolls).toEqual([19]);
  });

  it("puts the plugin's id and test id on the element with the role and name", () => {
    const { unmount } = mount(
      <kit.VirtualGrid
        aria-label="Photos"
        id="photos"
        data-testid="photo-grid"
        count={2}
        onItemActivate={() => {}}
        renderItem={(index) => `#${index}`}
      />
    );
    const grid = screen.getByTestId("photo-grid");
    expect(grid).toBe(screen.getByRole("grid", { name: "Photos" }));
    expect(grid.id).toBe("photos");
    expect(grid.hasAttribute("data-virtuoso-scroller")).toBe(true);
    unmount();

    mount(
      <kit.VirtualGrid
        aria-label="Photos"
        data-testid="photo-grid"
        count={2}
        renderItem={(index) => `#${index}`}
      />
    );
    expect(screen.getByTestId("photo-grid")).toBe(screen.getByRole("list", { name: "Photos" }));
  });

  it("survives the untyped props a zero-build view can send", () => {
    // Parsed rather than typed: this is the untyped shape plain JavaScript sends.
    const loose: kit.VirtualGridProps = JSON.parse(
      '{"aria-label":"Loose","count":"many","minColumnWidth":"wide","maxColumns":-1,"gap":"huge","overscan":"lots","selection":{"isSelected":1}}'
    );
    mount(<kit.VirtualGrid {...loose} renderItem={() => "card"} />);
    expect(screen.getByRole("list", { name: "Loose" })).toBeTruthy();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });
});
