// @vitest-environment jsdom
import { renderHook, act } from "@testing-library/react";
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
  liveWorktreeIds: readonly string[];
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
      const result = useSidebarVirtuosoReset({ ...props, scrollerRef });
      seenScrollTops.push(result.initialScrollTop);
      return result;
    },
    { initialProps }
  );
  return { ...view, scrollerRef, seenScrollTops };
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
    const { result } = renderReset({ itemCount: 5, liveWorktreeIds: ["a", "b", "c"] });
    expect(result.current.resetKey).toBe(0);
    expect(result.current.initialScrollTop).toBeUndefined();
  });

  it("resets when a shrink coincides with a removed live worktree", () => {
    const { result, rerender } = renderReset({
      itemCount: 5,
      liveWorktreeIds: ["a", "b", "c"],
    });
    // Two worktrees deleted at once: their rows go, and the two tombstones
    // collapse into a single group item — a net shrink.
    rerender({ itemCount: 2, liveWorktreeIds: ["a"] });
    expect(result.current.resetKey).toBe(1);
  });

  it("ignores a shrink whose live worktrees are all still present", () => {
    const { result, rerender } = renderReset({
      itemCount: 5,
      liveWorktreeIds: ["a", "b", "c"],
    });
    // Narrowing a search or a quick-state filter, and a tombstone retiring on
    // its own, all shrink the surface without deleting a worktree. Remounting
    // here would reset scroll under a user who did nothing.
    rerender({ itemCount: 3, liveWorktreeIds: ["a", "b", "c"] });
    expect(result.current.resetKey).toBe(0);
  });

  it("ignores a deletion that does not shrink the surface", () => {
    const { result, rerender } = renderReset({
      itemCount: 5,
      liveWorktreeIds: ["a", "b", "c"],
    });
    // A lone deletion swaps a row for a tombstone card — same item count, and
    // the geometry never goes stale. This is why single deletes never repro.
    rerender({ itemCount: 5, liveWorktreeIds: ["a", "b"] });
    expect(result.current.resetKey).toBe(0);
  });

  it("ignores growth and reordering", () => {
    const { result, rerender } = renderReset({
      itemCount: 5,
      liveWorktreeIds: ["a", "b", "c"],
    });
    rerender({ itemCount: 7, liveWorktreeIds: ["a", "b", "c", "d"] });
    rerender({ itemCount: 7, liveWorktreeIds: ["c", "a", "d", "b"] });
    expect(result.current.resetKey).toBe(0);
  });

  it("resets when a removal and an addition land together, shrinking the surface", () => {
    const { result, rerender } = renderReset({
      itemCount: 6,
      liveWorktreeIds: ["a", "b", "c"],
    });
    // Live count is unchanged, so only membership reveals the removal.
    rerender({ itemCount: 4, liveWorktreeIds: ["a", "b", "d"] });
    expect(result.current.resetKey).toBe(1);
  });

  it("resets once per shrink, not on every subsequent render", () => {
    const { result, rerender } = renderReset({
      itemCount: 5,
      liveWorktreeIds: ["a", "b", "c"],
    });
    rerender({ itemCount: 2, liveWorktreeIds: ["a"] });
    rerender({ itemCount: 2, liveWorktreeIds: ["a"] });
    rerender({ itemCount: 2, liveWorktreeIds: ["a"] });
    expect(result.current.resetKey).toBe(1);
  });

  it("hands the fresh instance the scroll offset it replaced, then drops it", () => {
    const { result, rerender, seenScrollTops } = renderReset(
      { itemCount: 5, liveWorktreeIds: ["a", "b", "c"] },
      400
    );
    rerender({ itemCount: 2, liveWorktreeIds: ["a"] });
    // Observable only mid-flight: the keyed mount reads it, then it is cleared
    // so a later empty-state remount can't restore a position from a list that
    // no longer exists.
    expect(seenScrollTops).toContain(400);
    expect(result.current.initialScrollTop).toBeUndefined();
  });

  it("leaves the offset unset when the list was already at the top", () => {
    const { seenScrollTops, rerender } = renderReset(
      { itemCount: 5, liveWorktreeIds: ["a", "b", "c"] },
      0
    );
    rerender({ itemCount: 2, liveWorktreeIds: ["a"] });
    expect(seenScrollTops.every((v) => v === undefined)).toBe(true);
  });

  it("skips the remount when Virtuoso is already unmounted", () => {
    // No scroller means the empty-state branch is showing: the geometry died
    // with the instance, and bumping the key would discard a healthy mount.
    const { result, rerender } = renderReset(
      { itemCount: 5, liveWorktreeIds: ["a", "b", "c"] },
      null
    );
    rerender({ itemCount: 2, liveWorktreeIds: ["a"] });
    expect(result.current.resetKey).toBe(0);
  });

  describe("drag safety (past lesson #8478)", () => {
    it("holds the reset while a drag is in flight", () => {
      const { result, rerender } = renderReset({
        itemCount: 5,
        liveWorktreeIds: ["a", "b", "c"],
      });
      act(() => dndListeners?.onDragStart?.({} as never));
      rerender({ itemCount: 2, liveWorktreeIds: ["a"] });
      expect(result.current.resetKey).toBe(0);
    });

    it("releases it a frame after dnd-kit restores focus, not before", () => {
      const { result, rerender } = renderReset({
        itemCount: 5,
        liveWorktreeIds: ["a", "b", "c"],
      });
      act(() => dndListeners?.onDragStart?.({} as never));
      rerender({ itemCount: 2, liveWorktreeIds: ["a"] });
      act(() => dndListeners?.onDragEnd?.({} as never));

      flushFrames();
      expect(result.current.resetKey).toBe(0);
      flushFrames();
      expect(result.current.resetKey).toBe(1);
    });

    it("releases it on a cancelled drag too", () => {
      const { result, rerender } = renderReset({
        itemCount: 5,
        liveWorktreeIds: ["a", "b", "c"],
      });
      act(() => dndListeners?.onDragStart?.({} as never));
      rerender({ itemCount: 2, liveWorktreeIds: ["a"] });
      act(() => dndListeners?.onDragCancel?.({} as never));

      flushFrames();
      flushFrames();
      expect(result.current.resetKey).toBe(1);
    });

    it("postpones again when a new drag starts inside the settling window", () => {
      const { result, rerender } = renderReset({
        itemCount: 5,
        liveWorktreeIds: ["a", "b", "c"],
      });
      act(() => dndListeners?.onDragStart?.({} as never));
      rerender({ itemCount: 2, liveWorktreeIds: ["a"] });
      act(() => dndListeners?.onDragEnd?.({} as never));
      act(() => dndListeners?.onDragStart?.({} as never));

      flushFrames();
      flushFrames();
      expect(result.current.resetKey).toBe(0);

      act(() => dndListeners?.onDragEnd?.({} as never));
      flushFrames();
      flushFrames();
      expect(result.current.resetKey).toBe(1);
    });

    it("schedules nothing when a drag ends with no reset pending", () => {
      renderReset({ itemCount: 5, liveWorktreeIds: ["a", "b", "c"] });
      act(() => dndListeners?.onDragStart?.({} as never));
      act(() => dndListeners?.onDragEnd?.({} as never));
      expect(rafQueue.size).toBe(0);
    });

    it("drops the queued frame on unmount so no state lands after teardown", () => {
      const { rerender, unmount } = renderReset({
        itemCount: 5,
        liveWorktreeIds: ["a", "b", "c"],
      });
      act(() => dndListeners?.onDragStart?.({} as never));
      rerender({ itemCount: 2, liveWorktreeIds: ["a"] });
      act(() => dndListeners?.onDragEnd?.({} as never));
      expect(rafQueue.size).toBe(1);

      unmount();
      expect(rafQueue.size).toBe(0);
    });
  });
});
