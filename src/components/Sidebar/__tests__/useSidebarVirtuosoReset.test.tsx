// @vitest-environment jsdom
import { renderHook, render, act } from "@testing-library/react";
import { useDeferredValue, useEffect, useState } from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { DndMonitorListener } from "@dnd-kit/core";
import { useSidebarVirtuosoReset } from "../useSidebarVirtuosoReset";

// The hook only ever reaches dnd-kit for the drag lifecycle, so a factory
// exposing just `useDndMonitor` covers its whole import surface.
let dndListeners: DndMonitorListener | null;
vi.mock("@dnd-kit/core", () => ({
  useDndMonitor: (listener: DndMonitorListener) => {
    dndListeners = listener;
  },
}));

// Dispatch through a helper that throws rather than optional-chaining: a
// listener that silently went missing would otherwise leave every drag test
// asserting nothing and still passing.
function dispatchDrag(event: "onDragStart" | "onDragEnd" | "onDragCancel") {
  const listener = dndListeners?.[event];
  if (!listener) throw new Error(`useDndMonitor received no ${event} listener`);
  act(() => listener({} as never));
}

// Controllable rAF queue: the post-drag release schedules a nested frame, so
// draining one level at a time is what proves the reset waits for dnd-kit's
// focus-restoration frame rather than landing on the first one.
let rafQueue: Map<number, FrameRequestCallback>;
let nextRafId: number;

function flushFrames() {
  const pending = [...rafQueue.values()];
  rafQueue.clear();
  act(() => {
    for (const cb of pending) cb(0);
  });
}

function makeScroller(scrollTop: number): HTMLElement {
  const el = document.createElement("div");
  Object.defineProperty(el, "scrollTop", { value: scrollTop, configurable: true });
  return el;
}

interface Props {
  itemCount: number;
  searchQuery: string;
  /** Defaults to `searchQuery` — the settled state these cases all describe. */
  liveQuery?: string;
}

/**
 * Renders the hook and records every `initialScrollTop` it returns. The offset
 * is transient by design — a passive effect clears it once the keyed mount has
 * consumed it — so the restored value is only observable across renders, never
 * in the settled result.
 */
function renderReset(initialProps: Props, scrollTop: number | null = 400) {
  const scrollerRef = { current: scrollTop === null ? null : makeScroller(scrollTop) };
  const seenScrollTops: (number | undefined)[] = [];
  const view = renderHook(
    (props: Props) => {
      const result = useSidebarVirtuosoReset({
        itemCount: props.itemCount,
        searchQuery: props.searchQuery,
        liveQuery: props.liveQuery ?? props.searchQuery,
        scrollerRef,
      });
      seenScrollTops.push(result.initialScrollTop);
      return result;
    },
    { initialProps }
  );
  return { ...view, scrollerRef, seenScrollTops };
}

/** How far the roster narrows as "feat" is typed one character at a time. */
const COUNT_FOR_QUERY: Record<string, number> = { "": 9, f: 7, fe: 5, fea: 3, feat: 2 };

interface TypingHandle {
  type: (query: string) => void;
  /** A background commit that touches neither the count nor the query. */
  tick: () => void;
}

/**
 * Drives the hook behind a *real* `useDeferredValue`, the way SidebarContent
 * wires it. Hand-driven prop pairs cannot express the shape that matters: each
 * keystroke commits twice, and the interleaved urgent commit — new input, list
 * not yet narrowed — is where a naive quiet test fires the previous keystroke's
 * reset. Every render's key is recorded, since a remount that is undone by the
 * next commit still tore the list down.
 */
function renderTypingHarness() {
  const scrollerRef: { current: HTMLElement | null } = { current: makeScroller(400) };
  const resetKeys: number[] = [];
  // Throwing placeholders, so a harness that never mounted fails loudly instead
  // of leaving every assertion below reading a key nothing ever drove.
  const unmounted = () => {
    throw new Error("typing harness has not mounted");
  };
  const handle: TypingHandle = { type: unmounted, tick: unmounted };

  function Harness() {
    const [liveQuery, setLiveQuery] = useState("");
    const [tick, setTick] = useState(0);
    const deferredQuery = useDeferredValue(liveQuery);
    const { resetKey } = useSidebarVirtuosoReset({
      itemCount: COUNT_FOR_QUERY[deferredQuery] ?? 0,
      searchQuery: deferredQuery,
      liveQuery,
      scrollerRef,
    });
    resetKeys.push(resetKey);
    useEffect(() => {
      handle.type = setLiveQuery;
      handle.tick = () => setTick((n) => n + 1);
    }, []);
    return <span data-tick={tick}>{resetKey}</span>;
  }

  render(<Harness />);
  return {
    resetKeys,
    type: (query: string) => act(() => handle.type(query)),
    tick: () => act(() => handle.tick()),
    currentKey: () => resetKeys[resetKeys.length - 1],
  };
}

beforeEach(() => {
  dndListeners = null;
  rafQueue = new Map();
  nextRafId = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    const id = ++nextRafId;
    rafQueue.set(id, cb);
    return id;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    rafQueue.delete(id);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useSidebarVirtuosoReset — issue #12094", () => {
  it("does not reset on the first commit", () => {
    const { result } = renderReset({ itemCount: 5, searchQuery: "" });
    expect(result.current.resetKey).toBe(0);
    expect(result.current.initialScrollTop).toBeUndefined();
  });

  it("resets when the surface shrinks", () => {
    const { result, rerender } = renderReset({ itemCount: 5, searchQuery: "" });
    // Two worktrees deleted at once: their rows go, and the two tombstones
    // collapse into a single group item — a net shrink.
    rerender({ itemCount: 4, searchQuery: "" });
    expect(result.current.resetKey).toBe(1);
  });

  it("resets on a shrink no deletion could be correlated with", () => {
    // A quick-state filter hides a row because its agent stopped, or a tombstone
    // is pruned when its last terminal leaves. Neither changes the live worktree
    // roster in the same commit, and both shift every index below them.
    const { result, rerender } = renderReset({ itemCount: 6, searchQuery: "" });
    rerender({ itemCount: 5, searchQuery: "" });
    expect(result.current.resetKey).toBe(1);
  });

  it("ignores growth", () => {
    const { result, rerender } = renderReset({ itemCount: 5, searchQuery: "" });
    rerender({ itemCount: 7, searchQuery: "" });
    rerender({ itemCount: 9, searchQuery: "" });
    expect(result.current.resetKey).toBe(0);
  });

  it("ignores a same-size update", () => {
    // A lone deletion swaps a row for a tombstone card — same item count, and
    // the geometry never goes stale. This is why single deletes never repro.
    const { result, rerender } = renderReset({ itemCount: 5, searchQuery: "" });
    rerender({ itemCount: 5, searchQuery: "" });
    expect(result.current.resetKey).toBe(0);
  });

  it("does not remount while the user is typing", () => {
    const { result, rerender } = renderReset({ itemCount: 9, searchQuery: "" });
    rerender({ itemCount: 4, searchQuery: "fea" });
    rerender({ itemCount: 2, searchQuery: "feat" });
    expect(result.current.resetKey).toBe(0);
  });

  it("resumes resetting once the query stops changing", () => {
    const { result, rerender } = renderReset({ itemCount: 9, searchQuery: "" });
    rerender({ itemCount: 4, searchQuery: "feat" });
    expect(result.current.resetKey).toBe(0);
    // Same query, list shrank anyway — a deletion landed under the filter.
    rerender({ itemCount: 3, searchQuery: "feat" });
    expect(result.current.resetKey).toBe(1);
  });

  it("still honours a shrink that landed on the same commit as a keystroke", () => {
    // A deletion arriving mid-search is structural, and nothing later reports
    // it again — so the exempted shrink is owed, not forgiven.
    const { result, rerender } = renderReset({ itemCount: 9, searchQuery: "" });
    rerender({ itemCount: 4, searchQuery: "feat" });
    expect(result.current.resetKey).toBe(0);
    // Query holds still and the list does not shrink again; the owed reset
    // fires anyway.
    rerender({ itemCount: 4, searchQuery: "feat" });
    expect(result.current.resetKey).toBe(1);
  });

  it("collapses a whole typing burst into one owed reset", () => {
    const { result, rerender } = renderReset({ itemCount: 9, searchQuery: "" });
    rerender({ itemCount: 7, searchQuery: "f" });
    rerender({ itemCount: 5, searchQuery: "fe" });
    rerender({ itemCount: 3, searchQuery: "fea" });
    expect(result.current.resetKey).toBe(0);
    rerender({ itemCount: 3, searchQuery: "fea" });
    expect(result.current.resetKey).toBe(1);
  });

  describe("behind a real useDeferredValue", () => {
    it("does not remount once per keystroke", () => {
      const harness = renderTypingHarness();
      for (const query of ["f", "fe", "fea", "feat"]) harness.type(query);
      // The regression scored one remount per keystroke, lagged by one: the
      // urgent commit carrying the next character read as quiet and paid off
      // the previous character's owed reset.
      expect(harness.resetKeys.filter((key) => key !== 0)).toEqual([]);
    });

    it("pays the burst off with a single reset once the query settles", () => {
      const harness = renderTypingHarness();
      for (const query of ["f", "fe", "fea", "feat"]) harness.type(query);
      expect(harness.currentKey()).toBe(0);
      harness.tick();
      expect(harness.currentKey()).toBe(1);
      harness.tick();
      expect(harness.currentKey()).toBe(1);
    });
  });

  it("resets once per shrink, not on every subsequent render", () => {
    const { result, rerender } = renderReset({ itemCount: 5, searchQuery: "" });
    rerender({ itemCount: 2, searchQuery: "" });
    rerender({ itemCount: 2, searchQuery: "" });
    rerender({ itemCount: 2, searchQuery: "" });
    expect(result.current.resetKey).toBe(1);
  });

  it("resets again for a second, independent shrink", () => {
    // A one-shot reset would pass every other test here and still strand a row
    // on the user's second bulk deletion.
    const { result, rerender } = renderReset({ itemCount: 5, searchQuery: "" });
    rerender({ itemCount: 3, searchQuery: "" });
    expect(result.current.resetKey).toBe(1);
    rerender({ itemCount: 1, searchQuery: "" });
    expect(result.current.resetKey).toBe(2);
  });

  it("resets when the surface empties out", () => {
    const { result, rerender } = renderReset({ itemCount: 3, searchQuery: "" });
    rerender({ itemCount: 0, searchQuery: "" });
    expect(result.current.resetKey).toBe(1);
  });

  it("hands the fresh instance the scroll offset it replaced, then drops it", () => {
    const { result, rerender, seenScrollTops } = renderReset(
      { itemCount: 5, searchQuery: "" },
      400
    );
    rerender({ itemCount: 2, searchQuery: "" });
    // Observable only mid-flight: the keyed mount reads it, then it is cleared
    // so a later empty-state remount can't restore a position from a list that
    // no longer exists.
    expect(seenScrollTops).toContain(400);
    expect(result.current.initialScrollTop).toBeUndefined();
  });

  it("leaves the offset unset when the list was already at the top", () => {
    const { seenScrollTops, rerender } = renderReset({ itemCount: 5, searchQuery: "" }, 0);
    rerender({ itemCount: 2, searchQuery: "" });
    expect(seenScrollTops.every((v) => v === undefined)).toBe(true);
  });

  it("skips the remount when Virtuoso is already unmounted", () => {
    // No scroller means the empty-state branch is showing: the geometry died
    // with the instance, and bumping the key would discard a healthy mount.
    const { result, rerender } = renderReset({ itemCount: 5, searchQuery: "" }, null);
    rerender({ itemCount: 2, searchQuery: "" });
    expect(result.current.resetKey).toBe(0);
  });

  describe("drag safety (past lesson #8478)", () => {
    it("holds the reset while a drag is in flight", () => {
      const { result, rerender } = renderReset({ itemCount: 5, searchQuery: "" });
      dispatchDrag("onDragStart");
      rerender({ itemCount: 2, searchQuery: "" });
      expect(result.current.resetKey).toBe(0);
    });

    it("releases it a frame after dnd-kit restores focus, not before", () => {
      const { result, rerender } = renderReset({ itemCount: 5, searchQuery: "" });
      dispatchDrag("onDragStart");
      rerender({ itemCount: 2, searchQuery: "" });
      dispatchDrag("onDragEnd");

      flushFrames();
      expect(result.current.resetKey).toBe(0);
      flushFrames();
      expect(result.current.resetKey).toBe(1);
    });

    it("holds a shrink that arrives after the drop but before focus is restored", () => {
      // The drag is already over, so a dragging-only guard would let this
      // through and destroy the activator dnd-kit is about to focus.
      const { result, rerender } = renderReset({ itemCount: 5, searchQuery: "" });
      dispatchDrag("onDragStart");
      dispatchDrag("onDragEnd");
      rerender({ itemCount: 2, searchQuery: "" });
      expect(result.current.resetKey).toBe(0);

      flushFrames();
      expect(result.current.resetKey).toBe(0);
      flushFrames();
      expect(result.current.resetKey).toBe(1);
    });

    it("releases it on a cancelled drag too", () => {
      const { result, rerender } = renderReset({ itemCount: 5, searchQuery: "" });
      dispatchDrag("onDragStart");
      rerender({ itemCount: 2, searchQuery: "" });
      dispatchDrag("onDragCancel");

      flushFrames();
      flushFrames();
      expect(result.current.resetKey).toBe(1);
    });

    it("postpones again when a new drag starts inside the settling window", () => {
      const { result, rerender } = renderReset({ itemCount: 5, searchQuery: "" });
      dispatchDrag("onDragStart");
      rerender({ itemCount: 2, searchQuery: "" });
      dispatchDrag("onDragEnd");
      dispatchDrag("onDragStart");

      flushFrames();
      flushFrames();
      expect(result.current.resetKey).toBe(0);

      dispatchDrag("onDragEnd");
      flushFrames();
      flushFrames();
      expect(result.current.resetKey).toBe(1);
    });

    it("coalesces several shrinks during one drag into a single remount", () => {
      const { result, rerender } = renderReset({ itemCount: 9, searchQuery: "" });
      dispatchDrag("onDragStart");
      rerender({ itemCount: 6, searchQuery: "" });
      rerender({ itemCount: 3, searchQuery: "" });
      dispatchDrag("onDragEnd");

      flushFrames();
      flushFrames();
      expect(result.current.resetKey).toBe(1);
    });

    it("drops the queued frame on unmount so no state lands after teardown", () => {
      const { rerender, unmount } = renderReset({ itemCount: 5, searchQuery: "" });
      dispatchDrag("onDragStart");
      rerender({ itemCount: 2, searchQuery: "" });
      dispatchDrag("onDragEnd");
      expect(rafQueue.size).toBe(1);

      unmount();
      expect(rafQueue.size).toBe(0);
    });
  });
});
