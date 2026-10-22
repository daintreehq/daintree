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
import { VirtuosoMockContext, type VirtuosoHandle, type VirtuosoProps } from "react-virtuoso";

// jsdom lays nothing out, so Virtuoso neither scrolls there nor reports the end
// again after its first render. The grid's props to it and its scroll requests
// are recorded instead, passing through unchanged.
interface RecordedProps {
  endReached: ((index: number) => void) | undefined;
  rows: readonly unknown[];
}

const virtuoso = vi.hoisted(() => ({
  props: new Array<RecordedProps>(),
  scrolls: new Array<number>(),
}));

vi.mock("react-virtuoso", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-virtuoso")>();
  function RecordingVirtuoso({
    ref,
    ...rest
  }: VirtuosoProps<unknown, unknown> & { ref?: Ref<VirtuosoHandle> }) {
    const inner = useRef<VirtuosoHandle>(null);
    useLayoutEffect(() => {
      virtuoso.props.push({ endReached: rest.endReached, rows: rest.data ?? [] });
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

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn(() => Promise.resolve()) },
}));

import * as kit from "@daintreehq/plugin-ui";
import { gridColumns, gridRows, gridStep } from "@/components/PluginKit/PluginKitVirtualGrid";

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

describe("gridRows", () => {
  it("splits the items into rows, the last one short", () => {
    expect(gridRows(10, 4)).toEqual([
      { start: 0, end: 4 },
      { start: 4, end: 8 },
      { start: 8, end: 10 },
    ]);
    expect(gridRows(0, 4)).toEqual([]);
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

  it("follows a controlled cursor and reports where it moves", () => {
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
    fireEvent.keyDown(grid, { key: "ArrowUp" });
    expect(onActiveIndexChange).toHaveBeenLastCalledWith(2);
    expect(activeTitle(grid)).toBe("#2");
  });

  it("reports the last item once per item count, also when a page only fills out the last row", () => {
    const onEndReached = vi.fn();
    const grid = (items: Photo[]) => (
      <VirtuosoMockContext.Provider value={{ viewportHeight: 600, itemHeight: 100 }}>
        <div style={{ height: 600 }}>
          <kit.VirtualGrid
            aria-label="Photos"
            items={items}
            itemKey={(_index, photo) => photo.id}
            onEndReached={onEndReached}
            renderItem={(_index, photo) => photo.title}
          />
        </div>
      </VirtuosoMockContext.Provider>
    );
    const view = render(grid(photos(9)));
    const endOf = () => lastProps().endReached!;
    const before = lastProps().rows;
    expect(before).toHaveLength(5);
    act(() => endOf()(4));
    expect(onEndReached).toHaveBeenCalledTimes(1);
    expect(onEndReached).toHaveBeenLastCalledWith(8);

    // Still five rows of two, the last one now full. The rows array is a new
    // one, which is what makes Virtuoso report the end again; it does so
    // through the callback it already holds, from the render before.
    const stale = endOf();
    view.rerender(grid(photos(10)));
    const after = lastProps().rows;
    expect(after).toHaveLength(5);
    expect(after).not.toBe(before);
    act(() => stale(4));
    expect(onEndReached).toHaveBeenCalledTimes(2);
    expect(onEndReached).toHaveBeenLastCalledWith(9);

    // A regroup changes the rows, not the items: nothing new to load.
    resizeTo(800);
    expect(lastProps().rows).toHaveLength(3);
    act(() => endOf()(2));
    expect(onEndReached).toHaveBeenCalledTimes(2);
  });

  it("scrolls the cursor's row into view, by row", () => {
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
    virtuoso.scrolls.length = 0;
    fireEvent.keyDown(grid, { key: "End", ctrlKey: true });
    // Item 39 of 40 in two columns is on row 19.
    expect(virtuoso.scrolls).toContain(19);
    virtuoso.scrolls.length = 0;
    resizeTo(800);
    // Four columns now: the same item sits on row 9.
    expect(virtuoso.scrolls).toContain(9);
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
