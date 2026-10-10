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
const looks = () => markSeen.mock.calls.map(([id, looking]) => `${String(id)}:${String(looking)}`);

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
  useCanopyStore.setState({ mode: "on" });
  usePanelStore.setState({
    panelsById: { a: terminal("a"), b: terminal("b"), gone: terminal("gone", "trash") },
    panelIds: ["a", "b", "gone"],
    focusedId: "a",
  });
});

afterEach(() => {
  useCanopyStore.setState({ isOpen: false, mode: "unset" });
  delete (window as { electron?: unknown }).electron;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("useCanopySeenTracking", () => {
  it("starts a look at the pane in focus, and ends it on the one focus left", () => {
    renderHook(() => useCanopySeenTracking());
    expect(looks()).toEqual(["a:true"]);
    markSeen.mockClear();

    act(() => usePanelStore.setState({ focusedId: "b" }));
    expect(looks()).toEqual(["a:false", "b:true"]);
  });

  it("tells every start and end, even a moment apart, so a quick switch through reads nothing", () => {
    renderHook(() => useCanopySeenTracking());
    act(() => usePanelStore.setState({ focusedId: "b" }));
    act(() => usePanelStore.setState({ focusedId: "a" }));
    expect(looks()).toEqual(["a:true", "a:false", "b:true", "b:false", "a:true"]);
  });

  it("looks at nothing while the window is behind another app", () => {
    windowFocused = false;
    renderHook(() => useCanopySeenTracking());
    act(() => usePanelStore.setState({ focusedId: "b" }));
    vi.advanceTimersByTime(CANOPY_SEEN_HEARTBEAT_MS);
    expect(markSeen).not.toHaveBeenCalled();
  });

  it("ends the look when the window loses focus, and starts one when it comes back", () => {
    renderHook(() => useCanopySeenTracking());
    markSeen.mockClear();
    windowFocused = false;
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    windowFocused = true;
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(looks()).toEqual(["a:false", "a:true"]);
  });

  it("ends the look when the view is hidden, however focus stands, and starts one when shown", () => {
    renderHook(() => useCanopySeenTracking());
    markSeen.mockClear();
    const hidden = (value: boolean) => {
      Object.defineProperty(document, "hidden", { value, configurable: true });
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
    };
    try {
      hidden(true);
      expect(looks()).toEqual(["a:false"]);
      hidden(false);
      expect(looks()).toEqual(["a:false", "a:true"]);
    } finally {
      Object.defineProperty(document, "hidden", { value: false, configurable: true });
    }
  });

  it("ends the look it holds when it goes away", () => {
    const { unmount } = renderHook(() => useCanopySeenTracking());
    markSeen.mockClear();
    unmount();
    expect(looks()).toEqual(["a:false"]);
  });

  it("keeps a pane in front of the user seen, but not while Canopy covers it", () => {
    renderHook(() => useCanopySeenTracking());
    markSeen.mockClear();
    vi.advanceTimersByTime(CANOPY_SEEN_HEARTBEAT_MS);
    expect(looks()).toEqual(["a:true"]);

    act(() => useCanopyStore.setState({ isOpen: true }));
    markSeen.mockClear();
    vi.advanceTimersByTime(CANOPY_SEEN_HEARTBEAT_MS * 2);
    expect(markSeen).not.toHaveBeenCalled();
  });

  it("ends the look at the focused pane when Canopy opens over it, and starts one as it closes", () => {
    renderHook(() => useCanopySeenTracking());
    vi.advanceTimersByTime(5_000);
    markSeen.mockClear();
    act(() => useCanopyStore.setState({ isOpen: true }));
    expect(looks()).toEqual(["a:false"]);
    act(() => useCanopyStore.setState({ isOpen: false }));
    expect(looks()).toEqual(["a:false", "a:true"]);
  });

  it("holds no look while Canopy isn't on, and starts one when it is turned on", () => {
    useCanopyStore.setState({ mode: "unset" });
    const view = renderHook(() => useCanopySeenTracking());
    expect(markSeen).not.toHaveBeenCalled();
    act(() => useCanopyStore.setState({ mode: "on" }));
    expect(markSeen.mock.calls).toEqual([["a", true, "pane"]]);
    act(() => useCanopyStore.setState({ mode: "hidden" }));
    expect(markSeen.mock.calls.at(-1)).toEqual(["a", false, "pane"]);
    view.unmount();
  });

  it("never looks at a pane in the trash", () => {
    renderHook(() => useCanopySeenTracking());
    vi.advanceTimersByTime(5_000);
    markSeen.mockClear();
    act(() => usePanelStore.setState({ focusedId: "gone" }));
    expect(looks()).toEqual(["a:false"]);
  });

  it("drops a refused report quietly", async () => {
    markSeen.mockRejectedValue(new Error("rate limited"));
    renderHook(() => useCanopySeenTracking());
    await act(async () => {});
    expect(looks()).toEqual(["a:true"]);
  });
});
