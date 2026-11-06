// @vitest-environment jsdom
import { renderHook, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { ListItem, VirtuosoHandle } from "react-virtuoso";
import { useScrollIndicator } from "../useScrollIndicator";

const NO_WAITING: ReadonlySet<string> = new Set();

function params(
  items: ReadonlyArray<{ kind: string; worktreeId?: string }>,
  overrides: {
    attentionWorktreeIds?: ReadonlySet<string>;
    problemWorktreeTones?: ReadonlyMap<string, "error" | "warning">;
    virtuosoRef?: { current: Pick<VirtuosoHandle, "scrollToIndex"> | null };
    smoothScroll?: boolean;
    bandHeightPx?: number;
    paused?: boolean;
  } = {}
) {
  return {
    items,
    attentionWorktreeIds: overrides.attentionWorktreeIds ?? NO_WAITING,
    problemWorktreeTones: overrides.problemWorktreeTones,
    virtuosoRef: overrides.virtuosoRef ?? { current: null },
    smoothScroll: overrides.smoothScroll ?? true,
    bandHeightPx: overrides.bandHeightPx,
    paused: overrides.paused,
  };
}

// Controllable rAF queue so we can assert the scroll path coalesces a burst of
// Virtuoso onScroll callbacks into a single in-flight frame (issue #9580).
let rafQueue: Map<number, FrameRequestCallback>;
let nextRafId: number;
let rafSpy: ReturnType<typeof vi.spyOn>;
let cancelSpy: ReturnType<typeof vi.spyOn>;

class MockResizeObserver implements ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function flushFrames() {
  const pending = [...rafQueue.values()];
  rafQueue.clear();
  act(() => {
    for (const cb of pending) cb(0);
  });
}

// Scroller with a mutable scrollTop so a test can scroll the container after
// caching geometry and assert the onScroll path recomputes against the new
// position without a fresh itemsRendered call.
function makeScroller(metrics: { scrollTop: number; scrollHeight?: number; clientHeight: number }) {
  const el = document.createElement("div");
  let scrollTop = metrics.scrollTop;
  Object.defineProperty(el, "scrollTop", {
    get: () => scrollTop,
    set: (v: number) => {
      scrollTop = v;
    },
    configurable: true,
  });
  Object.defineProperty(el, "scrollHeight", {
    value: metrics.scrollHeight ?? 1000,
    configurable: true,
  });
  Object.defineProperty(el, "clientHeight", { value: metrics.clientHeight, configurable: true });
  return el;
}

type Kind = "header" | "row";

function makeItems(kinds: Kind[]): { kind: string }[] {
  return kinds.map((kind) => ({ kind }));
}

function makeRendered(
  specs: Array<{ index: number; offset: number; size: number; kind: Kind }>
): ListItem<{ kind: string }>[] {
  return specs.map((s) => ({
    index: s.index,
    offset: s.offset,
    size: s.size,
    data: { kind: s.kind },
  })) as ListItem<{ kind: string }>[];
}

beforeEach(() => {
  rafQueue = new Map();
  nextRafId = 0;
  vi.stubGlobal("ResizeObserver", MockResizeObserver);
  rafSpy = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    const id = ++nextRafId;
    rafQueue.set(id, cb);
    return id;
  });
  cancelSpy = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    rafQueue.delete(id as number);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useScrollIndicator hidden-row counts (issue #9666)", () => {
  it("counts only worktree rows, excluding section headers", () => {
    // 2 headers + 8 rows, all within the rendered window. Header heights (30px)
    // differ from row heights (100px) — the old fraction estimate would have
    // mis-weighted them; the geometry walk must ignore headers entirely.
    const items = makeItems([
      "header",
      "row",
      "row",
      "row",
      "header",
      "row",
      "row",
      "row",
      "row",
      "row",
    ]);
    const { result } = renderHook(() => useScrollIndicator(params(items)));
    const scroller = makeScroller({ scrollTop: 250, clientHeight: 300 });
    act(() => {
      result.current.scrollerRef(scroller);
    });

    act(() => {
      result.current.handleItemsRendered(
        makeRendered([
          { index: 0, offset: 0, size: 30, kind: "header" },
          { index: 1, offset: 30, size: 100, kind: "row" },
          { index: 2, offset: 130, size: 100, kind: "row" },
          { index: 3, offset: 230, size: 100, kind: "row" },
          { index: 4, offset: 330, size: 30, kind: "header" },
          { index: 5, offset: 360, size: 100, kind: "row" },
          { index: 6, offset: 460, size: 100, kind: "row" },
          { index: 7, offset: 560, size: 100, kind: "row" },
          { index: 8, offset: 660, size: 100, kind: "row" },
          { index: 9, offset: 760, size: 100, kind: "row" },
        ])
      );
    });

    // Viewport [250, 550]. Rows 1,2 fully above; rows 7,8,9 fully below; rows
    // 3,5,6 visible. Headers never counted.
    expect(result.current.hiddenAbove.count).toBe(2);
    expect(result.current.hiddenBelow.count).toBe(3);
  });

  it("counts rows that sit outside the rendered overscan window", () => {
    // 20 rows; only indices 5..12 are mounted (rest unmounted past overscan).
    const items = makeItems(Array.from({ length: 20 }, () => "row" as Kind));
    const { result } = renderHook(() => useScrollIndicator(params(items)));
    const scroller = makeScroller({ scrollTop: 700, clientHeight: 300 });
    act(() => {
      result.current.scrollerRef(scroller);
    });

    act(() => {
      result.current.handleItemsRendered(
        makeRendered(
          Array.from({ length: 8 }, (_, k) => {
            const index = k + 5;
            return { index, offset: index * 100, size: 100, kind: "row" as Kind };
          })
        )
      );
    });

    // Viewport [700, 1000]. Unrendered: 5 rows above (0..4), 7 rows below
    // (13..19). Rendered above: idx 5,6. Rendered below: idx 10,11,12.
    expect(result.current.hiddenAbove.count).toBe(7);
    expect(result.current.hiddenBelow.count).toBe(10);
  });

  it("counts a row hidden within 1px of an edge, visible past it (epsilon)", () => {
    const items = makeItems(["row", "row", "row"]);
    const { result } = renderHook(() => useScrollIndicator(params(items)));
    const scroller = makeScroller({ scrollTop: 99, clientHeight: 100 });
    act(() => {
      result.current.scrollerRef(scroller);
    });
    const rendered = makeRendered([
      { index: 0, offset: 0, size: 100, kind: "row" },
      { index: 1, offset: 100, size: 100, kind: "row" },
      { index: 2, offset: 200, size: 100, kind: "row" },
    ]);
    act(() => {
      result.current.handleItemsRendered(rendered);
    });

    // Top edge — scrollTop 99, viewport [99, 199]: row 0's bottom (100) is
    // within 1px of the viewport top, so it counts as hidden-above. Row 2's top
    // (200) is within 1px of the viewport bottom (199), so it's hidden-below.
    expect(result.current.hiddenAbove.count).toBe(1);
    expect(result.current.hiddenBelow.count).toBe(1);

    // scrollTop 98, viewport [98, 198]: row 0 now shows 2px (past epsilon) so
    // it's visible; row 2's top (200) is 2px below the viewport bottom (198) so
    // it stays hidden-below.
    scroller.scrollTop = 98;
    act(() => {
      result.current.handleScroll();
    });
    flushFrames();
    expect(result.current.hiddenAbove.count).toBe(0);
    expect(result.current.hiddenBelow.count).toBe(1);
  });

  it("ignores section headers that sit outside the rendered window", () => {
    // header, row, row, header, row, row — only indices 3..5 are mounted.
    const items = makeItems(["header", "row", "row", "header", "row", "row"]);
    const { result } = renderHook(() => useScrollIndicator(params(items)));
    const scroller = makeScroller({ scrollTop: 400, clientHeight: 100 });
    act(() => {
      result.current.scrollerRef(scroller);
    });
    act(() => {
      result.current.handleItemsRendered(
        makeRendered([
          { index: 3, offset: 230, size: 30, kind: "header" },
          { index: 4, offset: 260, size: 100, kind: "row" },
          { index: 5, offset: 360, size: 100, kind: "row" },
        ])
      );
    });

    // Unrendered prefix items[0..2] = header + 2 rows → only the 2 rows count
    // above (the header is ignored). Viewport [400, 500]: rendered row 4
    // (260..360) is fully above → +1; row 5 (360..460) overlaps the viewport so
    // it's visible. Total hidden-above = 2 unrendered rows + row 4 = 3.
    expect(result.current.hiddenAbove.count).toBe(3);
    expect(result.current.hiddenBelow.count).toBe(0);
  });

  it("applies fresh geometry tagged for the new list right after an items change", () => {
    const itemsA = makeItems(["row", "row", "row"]);
    const itemsB = makeItems(["row", "row", "row", "row"]);
    const { result, rerender } = renderHook(({ items }) => useScrollIndicator(params(items)), {
      initialProps: { items: itemsA },
    });
    const scroller = makeScroller({ scrollTop: 250, clientHeight: 50 });
    act(() => {
      result.current.scrollerRef(scroller);
    });
    act(() => {
      result.current.handleItemsRendered(
        makeRendered([
          { index: 0, offset: 0, size: 100, kind: "row" },
          { index: 1, offset: 100, size: 100, kind: "row" },
          { index: 2, offset: 200, size: 100, kind: "row" },
        ])
      );
    });
    expect(result.current.hiddenAbove.count).toBe(2);

    // Swap the list, then immediately deliver fresh geometry for the new layout
    // (the order Virtuoso fires in). The identity guard must accept geometry
    // tagged for the current list — counts must reflect itemsB, not fall to 0/0.
    rerender({ items: itemsB });
    act(() => {
      result.current.handleItemsRendered(
        makeRendered([
          { index: 0, offset: 0, size: 100, kind: "row" },
          { index: 1, offset: 100, size: 100, kind: "row" },
          { index: 2, offset: 200, size: 100, kind: "row" },
          { index: 3, offset: 300, size: 100, kind: "row" },
        ])
      );
    });
    // Viewport [250, 300]: rows 0,1 above, row 2 visible, row 3 below.
    expect(result.current.hiddenAbove.count).toBe(2);
    expect(result.current.hiddenBelow.count).toBe(1);
  });

  it("reports 0/0 before any itemsRendered geometry has been captured", () => {
    const items = makeItems(["row", "row", "row"]);
    const { result } = renderHook(() => useScrollIndicator(params(items)));
    const scroller = makeScroller({ scrollTop: 250, clientHeight: 100 });
    act(() => {
      result.current.scrollerRef(scroller);
    });

    expect(result.current.hiddenAbove.count).toBe(0);
    expect(result.current.hiddenBelow.count).toBe(0);
  });

  it("resets counts when the backing list changes until new geometry arrives", () => {
    const itemsA = makeItems(["row", "row", "row"]);
    const itemsB = makeItems(["row", "row"]);
    const { result, rerender } = renderHook(({ items }) => useScrollIndicator(params(items)), {
      initialProps: { items: itemsA },
    });
    const scroller = makeScroller({ scrollTop: 250, clientHeight: 100 });
    act(() => {
      result.current.scrollerRef(scroller);
    });
    act(() => {
      result.current.handleItemsRendered(
        makeRendered([
          { index: 0, offset: 0, size: 100, kind: "row" },
          { index: 1, offset: 100, size: 100, kind: "row" },
          { index: 2, offset: 200, size: 100, kind: "row" },
        ])
      );
    });
    // Viewport [250, 350]: rows 0,1 above, row 2 visible.
    expect(result.current.hiddenAbove.count).toBe(2);

    // Swapping the list drops the stale geometry; counts fall back to 0/0 until
    // Virtuoso re-fires itemsRendered against the new layout.
    rerender({ items: itemsB });
    expect(result.current.hiddenAbove.count).toBe(0);
    expect(result.current.hiddenBelow.count).toBe(0);
  });
});

describe("useScrollIndicator scroll path (issues #9580, #9666)", () => {
  it("coalesces a burst of handleScroll calls into a single frame", () => {
    const items = makeItems(["row", "row", "row"]);
    const { result } = renderHook(() => useScrollIndicator(params(items)));
    const scroller = makeScroller({ scrollTop: 50, clientHeight: 100 });
    act(() => {
      result.current.scrollerRef(scroller);
    });

    rafSpy.mockClear();
    act(() => {
      result.current.handleScroll();
      result.current.handleScroll();
      result.current.handleScroll();
    });

    expect(rafSpy).toHaveBeenCalledTimes(1);
    expect(rafQueue.size).toBe(1);
  });

  it("recomputes counts on scroll using cached itemsRendered geometry", () => {
    const items = makeItems(["row", "row", "row"]);
    const { result, rerender } = renderHook(() => useScrollIndicator(params(items)));
    const scroller = makeScroller({ scrollTop: 0, clientHeight: 100 });
    act(() => {
      result.current.scrollerRef(scroller);
    });
    act(() => {
      result.current.handleItemsRendered(
        makeRendered([
          { index: 0, offset: 0, size: 100, kind: "row" },
          { index: 1, offset: 100, size: 100, kind: "row" },
          { index: 2, offset: 200, size: 100, kind: "row" },
        ])
      );
    });
    // Viewport [0, 100]: row 0 visible, rows 1,2 below.
    expect(result.current.hiddenAbove.count).toBe(0);
    expect(result.current.hiddenBelow.count).toBe(2);

    // Scroll down without a fresh itemsRendered — the onScroll path must reuse
    // the cached geometry against the new scrollTop.
    scroller.scrollTop = 250;
    act(() => {
      result.current.handleScroll();
    });
    flushFrames();
    rerender();
    // Viewport [250, 350]: rows 0,1 above, row 2 visible.
    expect(result.current.hiddenAbove.count).toBe(2);
    expect(result.current.hiddenBelow.count).toBe(0);
  });

  it("cancels a pending scroll frame and resets counts when the scroller detaches", () => {
    const items = makeItems(["row", "row", "row"]);
    const { result } = renderHook(() => useScrollIndicator(params(items)));
    const scroller = makeScroller({ scrollTop: 250, clientHeight: 100 });
    act(() => {
      result.current.scrollerRef(scroller);
    });
    act(() => {
      result.current.handleItemsRendered(
        makeRendered([
          { index: 0, offset: 0, size: 100, kind: "row" },
          { index: 1, offset: 100, size: 100, kind: "row" },
          { index: 2, offset: 200, size: 100, kind: "row" },
        ])
      );
    });
    expect(result.current.hiddenAbove.count).toBe(2);

    act(() => {
      result.current.handleScroll();
    });
    expect(rafQueue.size).toBe(1);

    cancelSpy.mockClear();
    act(() => {
      result.current.scrollerRef(null);
    });
    expect(cancelSpy).toHaveBeenCalled();
    expect(rafQueue.size).toBe(0);
    expect(result.current.hiddenAbove.count).toBe(0);
    expect(result.current.hiddenBelow.count).toBe(0);
  });

  it("a deferred scroll frame applies the latest hook closure after items change", () => {
    const itemsA = makeItems(["row", "row", "row"]);
    const itemsB = makeItems(["row"]);
    const { result, rerender } = renderHook(({ items }) => useScrollIndicator(params(items)), {
      initialProps: { items: itemsA },
    });
    const scroller = makeScroller({ scrollTop: 250, clientHeight: 100 });
    act(() => {
      result.current.scrollerRef(scroller);
    });
    act(() => {
      result.current.handleItemsRendered(
        makeRendered([
          { index: 0, offset: 0, size: 100, kind: "row" },
          { index: 1, offset: 100, size: 100, kind: "row" },
          { index: 2, offset: 200, size: 100, kind: "row" },
        ])
      );
    });

    // Schedule a frame under itemsA, then swap to itemsB before it flushes. The
    // deferred frame must read the latest closure (cleared geometry), not the
    // stale itemsA counts.
    act(() => {
      result.current.handleScroll();
    });
    rerender({ items: itemsB });
    flushFrames();

    expect(result.current.hiddenAbove.count).toBe(0);
    expect(result.current.hiddenBelow.count).toBe(0);
  });

  it("cancels a pending scroll frame on unmount", () => {
    const items = makeItems(["row", "row", "row"]);
    const { result, unmount } = renderHook(() => useScrollIndicator(params(items)));
    const scroller = makeScroller({ scrollTop: 50, clientHeight: 100 });
    act(() => {
      result.current.scrollerRef(scroller);
    });

    act(() => {
      result.current.handleScroll();
    });
    expect(rafQueue.size).toBe(1);

    cancelSpy.mockClear();
    act(() => {
      unmount();
    });
    expect(cancelSpy).toHaveBeenCalled();
    expect(rafQueue.size).toBe(0);
  });
});

describe("useScrollIndicator attention worktrees and reveal targets", () => {
  // Ten 100px rows, all mounted. Viewport [350, 650]: rows 0-2 hidden above,
  // row 3 cut by the top edge, rows 4-5 fully visible, row 6 cut by the bottom
  // edge, rows 7-9 hidden below.
  const rows = Array.from({ length: 10 }, (_, i) => ({ kind: "row", worktreeId: `w${i}` }));
  const geometry = makeRendered(
    rows.map((_, index) => ({ index, offset: index * 100, size: 100, kind: "row" as Kind }))
  );

  function setup(waiting: string[], smoothScroll = true) {
    const scrollToIndex = vi.fn<VirtuosoHandle["scrollToIndex"]>();
    const virtuosoRef = { current: { scrollToIndex } };
    const hook = renderHook(
      ({ waitingIds }: { waitingIds: ReadonlySet<string> }) =>
        useScrollIndicator(
          params(rows, { attentionWorktreeIds: waitingIds, virtuosoRef, smoothScroll })
        ),
      { initialProps: { waitingIds: new Set(waiting) as ReadonlySet<string> } }
    );
    act(() => {
      hook.result.current.scrollerRef(makeScroller({ scrollTop: 350, clientHeight: 300 }));
    });
    act(() => {
      hook.result.current.handleItemsRendered(geometry);
    });
    return { ...hook, scrollToIndex };
  }

  it("counts waiting worktrees per direction, ignoring ones on screen", () => {
    const { result } = setup(["w0", "w1", "w5", "w9"]);
    expect(result.current.hiddenAbove).toEqual({
      count: 3,
      attention: 2,
      problem: 0,
      problemTone: null,
    });
    expect(result.current.hiddenBelow).toEqual({
      count: 3,
      attention: 1,
      problem: 0,
      problemTone: null,
    });
  });

  it("recomputes when an agent starts waiting, without a scroll or a new list", () => {
    const { result, rerender } = setup([]);
    expect(result.current.hiddenBelow.attention).toBe(0);
    rerender({ waitingIds: new Set(["w8"]) });
    expect(result.current.hiddenBelow).toEqual({
      count: 3,
      attention: 1,
      problem: 0,
      problemTone: null,
    });
    rerender({ waitingIds: new Set() });
    expect(result.current.hiddenBelow).toEqual({
      count: 3,
      attention: 0,
      problem: 0,
      problemTone: null,
    });
  });

  it("reveals the NEAREST waiting worktree in each direction, centred", () => {
    const { result, scrollToIndex } = setup(["w0", "w1", "w8", "w9"]);
    act(() => result.current.revealBelow());
    expect(scrollToIndex).toHaveBeenLastCalledWith(
      expect.objectContaining({ index: 8, align: "center" })
    );
    act(() => result.current.revealAbove());
    expect(scrollToIndex).toHaveBeenLastCalledWith(
      expect.objectContaining({ index: 1, align: "center" })
    );
  });

  it("with nothing waiting, pages: the row cut by the edge moves to the opposite edge", () => {
    const { result, scrollToIndex } = setup([]);
    act(() => result.current.revealBelow());
    expect(scrollToIndex).toHaveBeenLastCalledWith(
      expect.objectContaining({ index: 6, align: "start" })
    );
    act(() => result.current.revealAbove());
    expect(scrollToIndex).toHaveBeenLastCalledWith(
      expect.objectContaining({ index: 3, align: "end" })
    );
  });

  it("jumps instantly when smooth scrolling is off", () => {
    const { result, scrollToIndex } = setup(["w9"], false);
    act(() => result.current.revealBelow());
    expect(scrollToIndex).toHaveBeenLastCalledWith(expect.objectContaining({ behavior: "auto" }));
  });
});

describe("useScrollIndicator problem worktrees", () => {
  // Same geometry as above: rows 0-2 hidden above, rows 7-9 hidden below.
  const rows = Array.from({ length: 10 }, (_, i) => ({ kind: "row", worktreeId: `w${i}` }));
  const geometry = makeRendered(
    rows.map((_, index) => ({ index, offset: index * 100, size: 100, kind: "row" as Kind }))
  );

  function setup(waiting: string[], problems: Array<[string, "error" | "warning"]>) {
    const scrollToIndex = vi.fn<VirtuosoHandle["scrollToIndex"]>();
    const virtuosoRef = { current: { scrollToIndex } };
    const hook = renderHook(
      ({ tones }: { tones: ReadonlyMap<string, "error" | "warning"> }) =>
        useScrollIndicator(
          params(rows, {
            attentionWorktreeIds: new Set(waiting),
            problemWorktreeTones: tones,
            virtuosoRef,
          })
        ),
      { initialProps: { tones: new Map(problems) as ReadonlyMap<string, "error" | "warning"> } }
    );
    act(() => {
      hook.result.current.scrollerRef(makeScroller({ scrollTop: 350, clientHeight: 300 }));
    });
    act(() => {
      hook.result.current.handleItemsRendered(geometry);
    });
    return { ...hook, scrollToIndex };
  }

  it("counts hidden problem rows per direction with the worst tone, ignoring ones on screen", () => {
    const { result } = setup(
      [],
      [
        ["w0", "warning"],
        ["w2", "error"],
        ["w5", "error"],
        ["w8", "warning"],
      ]
    );
    expect(result.current.hiddenAbove).toEqual({
      count: 3,
      attention: 0,
      problem: 2,
      problemTone: "error",
    });
    expect(result.current.hiddenBelow).toEqual({
      count: 3,
      attention: 0,
      problem: 1,
      problemTone: "warning",
    });
  });

  it("does not count a waiting row a second time as a problem", () => {
    const { result } = setup(["w8"], [["w8", "error"]]);
    expect(result.current.hiddenBelow).toEqual({
      count: 3,
      attention: 1,
      problem: 0,
      problemTone: null,
    });
  });

  it("recomputes when a problem appears, without a scroll or a new list", () => {
    const { result, rerender } = setup([], []);
    expect(result.current.hiddenBelow.problem).toBe(0);
    rerender({ tones: new Map([["w9", "error"]]) });
    expect(result.current.hiddenBelow).toEqual({
      count: 3,
      attention: 0,
      problem: 1,
      problemTone: "error",
    });
  });

  it("reveals the nearest problem when nothing past the edge is waiting", () => {
    const { result, scrollToIndex } = setup(
      [],
      [
        ["w0", "error"],
        ["w1", "warning"],
        ["w8", "warning"],
        ["w9", "error"],
      ]
    );
    act(() => result.current.revealBelow());
    expect(scrollToIndex).toHaveBeenLastCalledWith(
      expect.objectContaining({ index: 8, align: "center" })
    );
    act(() => result.current.revealAbove());
    expect(scrollToIndex).toHaveBeenLastCalledWith(
      expect.objectContaining({ index: 1, align: "center" })
    );
  });

  it("reveals a waiting row ahead of a nearer problem", () => {
    // The pill says "needs attention" first, so the jump has to land there.
    const { result, scrollToIndex } = setup(["w9"], [["w7", "error"]]);
    act(() => result.current.revealBelow());
    expect(scrollToIndex).toHaveBeenLastCalledWith(
      expect.objectContaining({ index: 9, align: "center" })
    );
  });
});

describe("useScrollIndicator paging past a card taller than the viewport", () => {
  // Rows 0-1 are 100px, row 2 is 800px, rows 3-4 are 100px. Viewport height 300.
  const rows = Array.from({ length: 5 }, (_, i) => ({ kind: "row", worktreeId: `w${i}` }));
  const geometry = makeRendered([
    { index: 0, offset: 0, size: 100, kind: "row" },
    { index: 1, offset: 100, size: 100, kind: "row" },
    { index: 2, offset: 200, size: 800, kind: "row" },
    { index: 3, offset: 1000, size: 100, kind: "row" },
    { index: 4, offset: 1100, size: 100, kind: "row" },
  ]);

  function setup(scrollTop: number) {
    const scrollToIndex = vi.fn<VirtuosoHandle["scrollToIndex"]>();
    const scroller = makeScroller({ scrollTop, clientHeight: 300, scrollHeight: 1200 });
    const scrollTo = vi.fn();
    Object.defineProperty(scroller, "scrollTo", { value: scrollTo });
    const { result } = renderHook(() =>
      useScrollIndicator(params(rows, { virtuosoRef: { current: { scrollToIndex } } }))
    );
    act(() => result.current.scrollerRef(scroller));
    act(() => result.current.handleItemsRendered(geometry));
    return { result, scrollToIndex, scrollTo };
  }

  // Viewport [200, 500]: the tall card starts exactly at the top edge, so
  // aligning it to "start" would be a no-op and the pill would do nothing.
  it("scrolls on by a viewport when the clipped card already fills it (below)", () => {
    const { result, scrollToIndex, scrollTo } = setup(200);
    act(() => result.current.revealBelow());
    expect(scrollToIndex).not.toHaveBeenCalled();
    expect(scrollTo).toHaveBeenLastCalledWith(expect.objectContaining({ top: 500 }));
  });

  // Viewport [700, 1000]: the tall card ends exactly at the bottom edge.
  it("scrolls back by a viewport when the clipped card already fills it (above)", () => {
    const { result, scrollToIndex, scrollTo } = setup(700);
    act(() => result.current.revealAbove());
    expect(scrollToIndex).not.toHaveBeenCalled();
    expect(scrollTo).toHaveBeenLastCalledWith(expect.objectContaining({ top: 400 }));
  });
});

describe("useScrollIndicator with the pills' bands (issue #15805)", () => {
  const BAND = 36;
  // Twenty 30px collapsed rows, all mounted: short enough that a whole row
  // fits behind a band.
  const rows = Array.from({ length: 20 }, (_, i) => ({ kind: "row", worktreeId: `w${i}` }));
  const geometry = makeRendered(
    rows.map((_, index) => ({ index, offset: index * 30, size: 30, kind: "row" as Kind }))
  );

  function setup(
    scrollTop: number,
    overrides: { bandHeightPx?: number; paused?: boolean } = { bandHeightPx: BAND },
    { waiting = [], clientHeight = 300 }: { waiting?: string[]; clientHeight?: number } = {}
  ) {
    const scrollToIndex = vi.fn<VirtuosoHandle["scrollToIndex"]>();
    const scroller = makeScroller({ scrollTop, clientHeight, scrollHeight: 600 });
    const scrollBy = vi.fn();
    Object.defineProperty(scroller, "scrollBy", { value: scrollBy });
    const attentionWorktreeIds: ReadonlySet<string> = new Set(waiting);
    const hook = renderHook(
      (props: { bandHeightPx?: number; paused?: boolean }) =>
        useScrollIndicator(
          params(rows, {
            virtuosoRef: { current: { scrollToIndex } },
            attentionWorktreeIds,
            ...props,
          })
        ),
      { initialProps: overrides }
    );
    act(() => hook.result.current.scrollerRef(scroller));
    act(() => hook.result.current.handleItemsRendered(geometry));
    return { ...hook, scroller, scrollToIndex, scrollBy };
  }

  function scrollTo(
    scroller: HTMLElement,
    result: { current: { handleScroll: () => void } },
    top: number
  ) {
    scroller.scrollTop = top;
    act(() => result.current.handleScroll());
    flushFrames();
  }

  // Viewport [95, 395]. Bare, rows 0-2 are past the top and 14-19 past the
  // bottom. Behind the bands the edges are 131 and 359, which takes row 3
  // (90-120) and rows 12-13 (360-420) with them.
  it("counts a row wholly behind a shown band as past that edge", () => {
    const bare = setup(95, {});
    expect(bare.result.current.hiddenAbove.count).toBe(3);
    expect(bare.result.current.hiddenBelow.count).toBe(6);
    expect(bare.result.current.bandInsets).toEqual({ top: 0, bottom: 0 });

    const banded = setup(95);
    expect(banded.result.current.hiddenAbove.count).toBe(4);
    expect(banded.result.current.hiddenBelow.count).toBe(8);
    expect(banded.result.current.bandInsets).toEqual({ top: BAND, bottom: BAND });
  });

  // Fed back into itself, the top band would keep counting row 0 (0-30) as
  // hidden at scrollTop 0 and so never come down.
  it("drops a band once nothing is past the bare edge, even with a row behind it", () => {
    const { result, scroller } = setup(95);
    expect(result.current.hiddenAbove.count).toBe(4);

    scrollTo(scroller, result, 0);
    expect(result.current.hiddenAbove.count).toBe(0);
    expect(result.current.bandInsets.top).toBe(0);

    // The same at the bottom: at the end of the list row 19 (570-600) would
    // sit behind a held-over bottom band.
    scrollTo(scroller, result, 300);
    expect(result.current.hiddenBelow.count).toBe(0);
    expect(result.current.hiddenAbove.count).toBe(11);
    expect(result.current.bandInsets).toEqual({ top: BAND, bottom: 0 });
  });

  // Rows 3 and 12 are on screen bare and behind the bands with them.
  it("counts and reveals a waiting worktree that only a band hides", () => {
    const { result, scrollToIndex } = setup(95, { bandHeightPx: BAND }, { waiting: ["w3", "w12"] });
    expect(result.current.hiddenAbove).toEqual({
      count: 4,
      attention: 1,
      problem: 0,
      problemTone: null,
    });
    expect(result.current.hiddenBelow).toEqual({
      count: 8,
      attention: 1,
      problem: 0,
      problemTone: null,
    });

    act(() => result.current.revealBelow());
    expect(scrollToIndex).toHaveBeenLastCalledWith({
      index: 12,
      align: "center",
      behavior: "smooth",
    });
    act(() => result.current.revealAbove());
    expect(scrollToIndex).toHaveBeenLastCalledWith({
      index: 3,
      align: "center",
      behavior: "smooth",
    });
  });

  // Bare viewport [95, 395] with 66px bands: edges at 161 and 329.
  it("re-measures when the band height changes", () => {
    const { result, rerender, scrollToIndex } = setup(95);
    rerender({ bandHeightPx: 66 });
    expect(result.current.hiddenAbove.count).toBe(5);
    expect(result.current.hiddenBelow.count).toBe(9);
    expect(result.current.bandInsets).toEqual({ top: 66, bottom: 66 });

    act(() => result.current.revealBelow());
    expect(scrollToIndex).toHaveBeenLastCalledWith(
      expect.objectContaining({ index: 11, align: "start", offset: -66 })
    );
  });

  it("steps aside in a list too short to give up two bands", () => {
    const { result } = setup(95, { bandHeightPx: BAND }, { clientHeight: 100 });
    expect(result.current.hiddenAbove.count).toBe(0);
    expect(result.current.hiddenBelow.count).toBe(0);
    expect(result.current.bandInsets).toEqual({ top: 0, bottom: 0 });
  });

  it("gives only the edge with something past it a band", () => {
    const { result } = setup(0);
    expect(result.current.hiddenAbove.count).toBe(0);
    // Bare viewport [0, 300]: rows 10-19 are past the bottom; the band takes
    // row 9 (270-300) too.
    expect(result.current.hiddenBelow.count).toBe(11);
    expect(result.current.bandInsets).toEqual({ top: 0, bottom: BAND });
  });

  it("parks a paged-to row a band's height in from the edge it lands on", () => {
    const { result, scrollToIndex } = setup(95);
    act(() => result.current.revealBelow());
    expect(scrollToIndex).toHaveBeenLastCalledWith(
      expect.objectContaining({ index: 12, align: "start", offset: -BAND })
    );
    // Row 4 (120-150) is cut by the top band's edge at 131.
    act(() => result.current.revealAbove());
    expect(scrollToIndex).toHaveBeenLastCalledWith(
      expect.objectContaining({ index: 4, align: "end", offset: BAND })
    );
  });

  it("reports nothing and covers nothing while paused, and recounts on resume", () => {
    const { result, rerender } = setup(95, { bandHeightPx: BAND, paused: true });
    expect(result.current.hiddenAbove.count).toBe(0);
    expect(result.current.hiddenBelow.count).toBe(0);
    expect(result.current.bandInsets).toEqual({ top: 0, bottom: 0 });

    rerender({ bandHeightPx: BAND, paused: false });
    expect(result.current.hiddenAbove.count).toBe(4);
    expect(result.current.bandInsets).toEqual({ top: BAND, bottom: BAND });
  });

  it("clears both pills the moment a drag starts, even with a scroll frame pending", () => {
    const { result, rerender, scroller } = setup(95);
    expect(result.current.hiddenAbove.count).toBe(4);

    scroller.scrollTop = 120;
    act(() => result.current.handleScroll());
    rerender({ bandHeightPx: BAND, paused: true });
    const cleared = { count: 0, attention: 0, problem: 0, problemTone: null };
    expect(result.current.hiddenAbove).toEqual(cleared);
    expect(result.current.hiddenBelow).toEqual(cleared);
    expect(result.current.bandInsets).toEqual({ top: 0, bottom: 0 });

    flushFrames();
    expect(result.current.hiddenAbove).toEqual(cleared);
    expect(result.current.hiddenBelow).toEqual(cleared);
  });

  it("hands a wheel over a band on to the list", () => {
    const { result, scrollBy, scroller } = setup(95);
    const wheel = (deltaY: number, deltaMode = 0, ctrlKey = false) =>
      result.current.handleBandWheel({ deltaY, deltaMode, ctrlKey });

    wheel(120);
    expect(scrollBy).toHaveBeenLastCalledWith({ top: 120 });
    wheel(-3, WheelEvent.DOM_DELTA_LINE);
    expect(scrollBy).toHaveBeenLastCalledWith({ top: -120 });
    Object.defineProperty(scroller, "clientHeight", { value: 240, configurable: true });
    wheel(-2, WheelEvent.DOM_DELTA_PAGE);
    expect(scrollBy).toHaveBeenLastCalledWith({ top: -480 });

    scrollBy.mockClear();
    wheel(120, 0, true);
    wheel(0);
    expect(scrollBy).not.toHaveBeenCalled();
  });
});

describe("useScrollIndicator paging past a tall card between bands", () => {
  const BAND = 36;
  const rows = Array.from({ length: 5 }, (_, i) => ({ kind: "row", worktreeId: `w${i}` }));
  const geometry = makeRendered([
    { index: 0, offset: 0, size: 100, kind: "row" },
    { index: 1, offset: 100, size: 100, kind: "row" },
    { index: 2, offset: 200, size: 800, kind: "row" },
    { index: 3, offset: 1000, size: 100, kind: "row" },
    { index: 4, offset: 1100, size: 100, kind: "row" },
  ]);

  function setup(scrollTop: number, clientHeight = 300) {
    const scroller = makeScroller({ scrollTop, clientHeight, scrollHeight: 1200 });
    const scrollTo = vi.fn();
    Object.defineProperty(scroller, "scrollTo", { value: scrollTo });
    const { result } = renderHook(() =>
      useScrollIndicator(
        params(rows, {
          virtuosoRef: { current: { scrollToIndex: vi.fn() } },
          bandHeightPx: BAND,
        })
      )
    );
    act(() => result.current.scrollerRef(scroller));
    act(() => result.current.handleItemsRendered(geometry));
    return { result, scrollTo };
  }

  // Both bands are up, so 228px of the card shows between them; the step is
  // that, so the strip that was behind the far band comes into view next.
  it("steps by the space between the bands", () => {
    const below = setup(200);
    act(() => below.result.current.revealBelow());
    expect(below.scrollTo).toHaveBeenLastCalledWith(expect.objectContaining({ top: 428 }));

    const above = setup(700);
    act(() => above.result.current.revealAbove());
    expect(above.scrollTo).toHaveBeenLastCalledWith(expect.objectContaining({ top: 472 }));
  });

  // A 120px list still has room for both bands, with 48px between them. Any
  // longer step would skip part of the card.
  it("never steps further than what shows between the bands", () => {
    const below = setup(200, 120);
    act(() => below.result.current.revealBelow());
    expect(below.scrollTo).toHaveBeenLastCalledWith(expect.objectContaining({ top: 248 }));

    const above = setup(700, 120);
    act(() => above.result.current.revealAbove());
    expect(above.scrollTo).toHaveBeenLastCalledWith(expect.objectContaining({ top: 652 }));
  });
});
