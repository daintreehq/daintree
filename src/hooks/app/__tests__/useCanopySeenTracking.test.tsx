// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { usePanelStore } from "@/store/panelStore";
import { useCanopyStore } from "@/store/canopyStore";
import { CANOPY_SEEN_HEARTBEAT_MS, __resetCanopySeenForTests } from "@/lib/canopySeen";
import { useCanopySeenTracking } from "../useCanopySeenTracking";

function terminal(id: string, location: "grid" | "trash" = "grid") {
  return { id, kind: "terminal", title: id, cwd: "/tmp", cols: 80, rows: 24, location } as never;
}

let markSeen: ReturnType<typeof vi.fn>;
let windowFocused = true;
const marked = () => markSeen.mock.calls.map(([id]) => id as string);

beforeEach(() => {
  vi.useFakeTimers();
  __resetCanopySeenForTests();
  windowFocused = true;
  vi.spyOn(document, "hasFocus").mockImplementation(() => windowFocused);
  markSeen = vi.fn(async () => {});
  Object.defineProperty(window, "electron", {
    value: { canopy: { markSeen } },
    configurable: true,
    writable: true,
  });
  usePanelStore.setState({
    panelsById: { a: terminal("a"), b: terminal("b"), gone: terminal("gone", "trash") },
    panelIds: ["a", "b", "gone"],
    focusedId: "a",
  });
});

afterEach(() => {
  useCanopyStore.setState({ isOpen: false });
  delete (window as { electron?: unknown }).electron;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("useCanopySeenTracking", () => {
  it("marks the pane in focus as seen, and the one it left as seen up to then", () => {
    renderHook(() => useCanopySeenTracking());
    expect(marked()).toEqual(["a"]);
    vi.advanceTimersByTime(5_000);
    markSeen.mockClear();

    act(() => usePanelStore.setState({ focusedId: "b" }));
    expect(marked()).toEqual(["a", "b"]);
  });

  it("counts looks at one pane a moment apart as one", () => {
    renderHook(() => useCanopySeenTracking());
    act(() => usePanelStore.setState({ focusedId: "b" }));
    act(() => usePanelStore.setState({ focusedId: "a" }));
    expect(marked()).toEqual(["a", "b"]);
  });

  it("marks nothing while the window is behind another app", () => {
    windowFocused = false;
    renderHook(() => useCanopySeenTracking());
    act(() => usePanelStore.setState({ focusedId: "b" }));
    vi.advanceTimersByTime(CANOPY_SEEN_HEARTBEAT_MS);
    expect(markSeen).not.toHaveBeenCalled();
  });

  it("keeps a pane in front of the user seen, but not while Canopy covers it", () => {
    renderHook(() => useCanopySeenTracking());
    markSeen.mockClear();
    vi.advanceTimersByTime(CANOPY_SEEN_HEARTBEAT_MS);
    expect(marked()).toEqual(["a"]);

    act(() => useCanopyStore.setState({ isOpen: true }));
    markSeen.mockClear();
    vi.advanceTimersByTime(CANOPY_SEEN_HEARTBEAT_MS * 2);
    expect(markSeen).not.toHaveBeenCalled();
  });

  it("marks the focused pane when Canopy opens over it", () => {
    renderHook(() => useCanopySeenTracking());
    vi.advanceTimersByTime(5_000);
    markSeen.mockClear();
    act(() => useCanopyStore.setState({ isOpen: true }));
    expect(marked()).toEqual(["a"]);
  });

  it("never marks a pane in the trash", () => {
    renderHook(() => useCanopySeenTracking());
    vi.advanceTimersByTime(5_000);
    markSeen.mockClear();
    act(() => usePanelStore.setState({ focusedId: "gone" }));
    expect(marked()).toEqual(["a"]);
  });

  it("drops a refused report quietly", async () => {
    markSeen.mockRejectedValue(new Error("rate limited"));
    renderHook(() => useCanopySeenTracking());
    await act(async () => {});
    expect(marked()).toEqual(["a"]);
  });
});
