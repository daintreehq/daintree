// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DragCancelEvent, DndMonitorListener } from "@dnd-kit/core";
import type { WorktreeState } from "@/types";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { useWorktreeFilterStore } from "@/store/worktreeFilterStore";
import { useSidebarReorderSession } from "../useSidebarReorderSession";

// The session reaches dnd-kit only through its monitor, so capturing the
// listener is enough to drive a drag cancel without a live DndContext.
let dndListener: DndMonitorListener | null = null;
vi.mock("@dnd-kit/core", () => ({
  useDndMonitor: (listener: DndMonitorListener) => {
    dndListener = listener;
  },
}));

function cancelDrag(data: Record<string, unknown>) {
  const onDragCancel = dndListener?.onDragCancel;
  if (!onDragCancel) throw new Error("useDndMonitor received no onDragCancel listener");
  const event: DragCancelEvent = {
    active: {
      id: "drag",
      data: { current: data },
      rect: { current: { initial: null, translated: null } },
    },
    activatorEvent: new Event("keydown"),
    collisions: null,
    delta: { x: 0, y: 0 },
    over: null,
  };
  act(() => onDragCancel(event));
}

function startDrag() {
  const onDragStart = dndListener?.onDragStart;
  if (!onDragStart) throw new Error("useDndMonitor received no onDragStart listener");
  act(() =>
    onDragStart({
      active: {
        id: "drag",
        data: { current: undefined },
        rect: { current: { initial: null, translated: null } },
      },
      activatorEvent: new Event("keydown"),
    })
  );
}

function makeWorktree(id: string, overrides: Partial<WorktreeState> = {}): WorktreeState {
  return {
    id,
    worktreeId: id,
    path: `/repo/${id}`,
    name: id,
    isCurrent: false,
    isMainWorktree: false,
    worktreeChanges: null,
    lastActivityTimestamp: null,
    ...overrides,
  };
}

const WORKTREES = [
  makeWorktree("a", { issueTitle: "Fix the login race", branch: "fix/login" }),
  makeWorktree("b", { branch: "feature/b" }),
  makeWorktree("c"),
];

interface SessionProps {
  worktrees: readonly WorktreeState[];
  dragStartOrder: readonly string[];
  isGroupedByType: boolean;
  liveQuery: string;
}

const INITIAL_PROPS: SessionProps = {
  worktrees: WORKTREES,
  dragStartOrder: ["a", "b", "c"],
  isGroupedByType: false,
  liveQuery: "",
};

function renderSession(props: Partial<SessionProps> = {}) {
  return renderHook((p: SessionProps) => useSidebarReorderSession(p), {
    initialProps: { ...INITIAL_PROPS, ...props },
  });
}

// Block body: an expression body returns the timer API, which picks act()'s
// async overload and leaves a promise floating.
function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function politeAnnouncement(): string | undefined {
  return useAnnouncerStore.getState().polite?.msg;
}

beforeEach(() => {
  vi.useFakeTimers();
  dndListener = null;
  useAnnouncerStore.setState({ polite: null, assertive: null });
  const filterStore = useWorktreeFilterStore.getState();
  filterStore.setManualOrder([]);
  filterStore.setOrderBy("created");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useSidebarReorderSession — keyboard reorder", () => {
  it("writes the moved order as a manual sort and announces only the resting position", () => {
    const { result, rerender } = renderSession();

    act(() => result.current.handleKeyboardReorder("a", 1));
    advance(100);
    rerender({ ...INITIAL_PROPS, dragStartOrder: ["b", "a", "c"] });
    act(() => result.current.handleKeyboardReorder("a", 1));

    const filterState = useWorktreeFilterStore.getState();
    expect(filterState.manualOrder).toEqual(["b", "c", "a"]);
    expect(filterState.orderBy).toBe("manual");
    // Past the first move's deadline: key-repeat must not speak the slot it
    // passed through on the way.
    advance(100);
    expect(result.current.keyboardReorderAnnouncement).toBe("");

    advance(50);
    expect(result.current.keyboardReorderAnnouncement).toBe(
      "Moved 'Fix the login race' to position 3 of 3"
    );
  });

  it("keeps one callback identity that reads the latest order, labels and sort state", () => {
    const { result, rerender } = renderSession();
    const firstCallback = result.current.handleKeyboardReorder;

    rerender({ ...INITIAL_PROPS, isGroupedByType: true });
    act(() => result.current.handleKeyboardReorder("a", 1));
    expect(useWorktreeFilterStore.getState().manualOrder).toEqual([]);

    const renamed = WORKTREES.map((w) => (w.id === "b" ? { ...w, branch: "feature/renamed" } : w));
    rerender({ ...INITIAL_PROPS, worktrees: renamed, dragStartOrder: ["c", "b", "a"] });
    expect(result.current.handleKeyboardReorder).toBe(firstCallback);

    act(() => result.current.handleKeyboardReorder("b", -1));
    expect(useWorktreeFilterStore.getState().manualOrder).toEqual(["b", "c", "a"]);
    advance(150);
    expect(result.current.keyboardReorderAnnouncement).toBe(
      "Moved 'feature/renamed' to position 1 of 3"
    );
  });

  it("ignores a move past either end of the list", () => {
    const { result } = renderSession();

    act(() => result.current.handleKeyboardReorder("a", -1));
    act(() => result.current.handleKeyboardReorder("c", 1));
    advance(150);

    expect(useWorktreeFilterStore.getState().manualOrder).toEqual([]);
    expect(result.current.keyboardReorderAnnouncement).toBe("");
  });

  it.each([
    ["grouped by type", { isGroupedByType: true }],
    ["searching", { liveQuery: "login" }],
  ])("refuses to reorder while %s", (_label, props) => {
    const { result } = renderSession(props);

    act(() => result.current.handleKeyboardReorder("a", 1));

    expect(result.current.isSortDisabled).toBe(true);
    expect(useWorktreeFilterStore.getState().manualOrder).toEqual([]);
  });
});

describe("useSidebarReorderSession — reorder availability", () => {
  it("names why drag reorder is off, with the search outranking the grouping", () => {
    const { result, rerender } = renderSession({ isGroupedByType: true });
    expect(result.current.dragDisabledReason).toBe("Drag to reorder is off while grouped by type");

    rerender({ ...INITIAL_PROPS, isGroupedByType: true, liveQuery: "x" });
    expect(result.current.dragDisabledReason).toBe("Drag to reorder is off while searching");

    rerender({ ...INITIAL_PROPS });
    expect(result.current.dragDisabledReason).toBeNull();
    expect(result.current.isSortDisabled).toBe(false);
  });

  it("stays silent on mount and speaks each new reason", () => {
    const { rerender } = renderSession({ isGroupedByType: true });
    expect(politeAnnouncement()).toBeUndefined();

    rerender({ ...INITIAL_PROPS, isGroupedByType: true, liveQuery: "x" });
    expect(politeAnnouncement()).toBe("Drag to reorder is off while searching");
  });

  it("announces that manual reorder is back once the search clears", () => {
    const { result, rerender } = renderSession({ liveQuery: "x" });

    rerender({ ...INITIAL_PROPS });
    expect(result.current.keyboardReorderAnnouncement).toBe("");
    advance(150);

    expect(result.current.keyboardReorderAnnouncement).toBe("Manual reorder available");
  });

  it("drops a pending announcement when the sidebar unmounts", () => {
    const { result, unmount } = renderSession();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");

    act(() => result.current.handleKeyboardReorder("a", 1));
    const announcementTimer = setTimeoutSpy.mock.results.at(-1)?.value;
    expect(announcementTimer).toBeDefined();
    unmount();

    expect(clearTimeoutSpy).toHaveBeenCalledWith(announcementTimer);
  });
});

describe("useSidebarReorderSession — drag cancel", () => {
  it("interrupts with the worktree's headline and drops the pending move announcement", () => {
    const { result } = renderSession();

    act(() => result.current.handleKeyboardReorder("b", 1));
    cancelDrag({ type: "worktree-sort", worktreeId: "a" });
    advance(150);

    expect(result.current.keyboardReorderAnnouncement).toBe("");
    expect(result.current.keyboardCancelAnnouncement).toBe(
      "Drag cancelled. Fix the login race returned to its original position"
    );
  });

  it("clears the previous cancel so a repeat reads as new content", () => {
    const { result } = renderSession();

    cancelDrag({ type: "worktree-sort", worktreeId: "c" });
    advance(50);
    expect(result.current.keyboardCancelAnnouncement).toBe(
      "Drag cancelled. c returned to its original position"
    );

    cancelDrag({ type: "worktree-sort", worktreeId: "c" });
    expect(result.current.keyboardCancelAnnouncement).toBe("");
    advance(50);
    expect(result.current.keyboardCancelAnnouncement).toBe(
      "Drag cancelled. c returned to its original position"
    );
  });

  it("drops a cancel announcement still pending when the next drag starts", () => {
    const { result } = renderSession();

    cancelDrag({ type: "worktree-sort", worktreeId: "a" });
    startDrag();
    advance(50);

    expect(result.current.keyboardCancelAnnouncement).toBe("");
  });

  it("ignores a cancelled drag that is not a worktree sort", () => {
    const { result } = renderSession();

    cancelDrag({ type: "terminal", terminalId: "t1" });
    advance(50);

    expect(result.current.keyboardCancelAnnouncement).toBe("");
  });
});
