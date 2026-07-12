// @vitest-environment jsdom
/**
 * useProjectSwitcherPalette — hover-to-prefetch (issue #7661).
 *
 * The project switcher palette silently primes the main-process hydrate cache
 * on pointerenter (mouse only) so a subsequent click resolves the new view's
 * `app:hydrate` IPC as a cache hit. The 150ms trailing-edge debounce filters
 * cursor traversal across the list; pointerleave cancels a pending prefetch;
 * palette close clears the timer; the freshness gate dedups re-hovers within
 * 15s. Hover never triggers visible loading state.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { prefetchHydrateMock, useProjectStoreMock, notifyMock, projectState, projectStatsState } =
  vi.hoisted(() => {
    const prefetchHydrateMock = vi.fn().mockResolvedValue(undefined);

    const projectStatsState = {
      stats: {} as Record<
        string,
        { activeAgentCount: number; waitingAgentCount: number; processCount: number }
      >,
    };

    const projectState = {
      projects: [
        {
          id: "project-1",
          name: "Project One",
          path: "/repo/one",
          emoji: "🌲",
          color: "#00aa00",
          lastOpened: 123,
          frecencyScore: 3.0,
          status: "active" as const,
        },
        {
          id: "project-2",
          name: "Project Two",
          path: "/repo/two",
          emoji: "🌳",
          color: "#0044aa",
          lastOpened: 456,
          frecencyScore: 3.0,
          status: "active" as const,
        },
      ],
      currentProject: null as { id: string } | null,
      switchProject: vi.fn().mockResolvedValue(undefined),
      reopenProject: vi.fn().mockResolvedValue(undefined),
      loadProjects: vi.fn().mockResolvedValue(undefined),
      addProject: vi.fn().mockResolvedValue(undefined),
      closeProject: vi.fn().mockResolvedValue({ processesKilled: 0 }),
      closeActiveProject: vi.fn().mockResolvedValue({ processesKilled: 0 }),
      removeProject: vi.fn().mockResolvedValue(undefined),
      locateProject: vi.fn().mockResolvedValue(undefined),
    };

    const useProjectStoreMock = Object.assign(
      vi.fn((selector: (state: typeof projectState) => unknown) => selector(projectState)),
      { getState: () => projectState }
    );
    const notifyMock = vi.fn().mockReturnValue("");

    return {
      prefetchHydrateMock,
      useProjectStoreMock,
      notifyMock,
      projectState,
      projectStatsState,
    };
  });

vi.mock("@/clients", () => ({
  projectClient: {
    prefetchHydrate: prefetchHydrateMock,
    getBulkStats: vi.fn().mockResolvedValue({}),
  },
  scratchClient: {
    saveAsProject: vi.fn().mockResolvedValue({ status: "cancelled" }),
  },
}));

vi.mock("@/store/projectStore", () => ({
  useProjectStore: useProjectStoreMock,
}));

vi.mock("@/store/projectStatsStore", () => ({
  useProjectStatsStore: Object.assign(
    vi.fn((selector: (state: typeof projectStatsState) => unknown) => selector(projectStatsState)),
    {
      getState: () => ({
        stats: projectStatsState.stats,
        setStats: (stats: typeof projectStatsState.stats) => {
          projectStatsState.stats = stats;
        },
      }),
    }
  ),
}));

vi.mock("@/store/projectSettingsStore", () => ({
  useProjectSettingsStore: Object.assign(
    vi.fn((selector?: (state: unknown) => unknown) =>
      selector ? selector({ loadNotificationOverridesForProjects: vi.fn() }) : undefined
    ),
    {
      getState: () => ({
        loadNotificationOverridesForProjects: vi.fn(),
      }),
    }
  ),
}));

// Hoisted so every selector call returns stable action identities. A fresh state
// object per call would churn the hook's effect deps on every render.
vi.mock("@/store/scratchStore", () => {
  const state = {
    scratches: [],
    currentScratch: null,
    loadScratches: vi.fn().mockResolvedValue(undefined),
    createScratch: vi.fn().mockResolvedValue({ id: "s1" }),
    switchScratch: vi.fn().mockResolvedValue(undefined),
    removeScratch: vi.fn().mockResolvedValue(undefined),
    renameScratch: vi.fn().mockResolvedValue(undefined),
  };
  return {
    useScratchStore: vi.fn((selector?: (s: unknown) => unknown) =>
      selector ? selector(state) : state
    ),
  };
});

vi.mock("@/lib/notify", () => ({
  notify: notifyMock,
}));

import { usePaletteStore } from "@/store/paletteStore";
import { useProjectSwitcherPalette } from "../useProjectSwitcherPalette";

describe("useProjectSwitcherPalette hover prefetch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    prefetchHydrateMock.mockReset();
    prefetchHydrateMock.mockResolvedValue(undefined);
    projectState.currentProject = null;
    projectStatsState.stats = {};
    usePaletteStore.setState({ activePaletteId: null });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires prefetchHydrate 150ms after pointerenter (mouse)", async () => {
    const { result } = renderHook(() => useProjectSwitcherPalette());

    act(() => {
      result.current.onHoverProject("project-1", "mouse");
    });

    expect(prefetchHydrateMock).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    expect(prefetchHydrateMock).toHaveBeenCalledTimes(1);
    expect(prefetchHydrateMock).toHaveBeenCalledWith("project-1");
  });

  it("does not fire before the debounce elapses", async () => {
    const { result } = renderHook(() => useProjectSwitcherPalette());

    act(() => {
      result.current.onHoverProject("project-1", "mouse");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(149);
    });

    expect(prefetchHydrateMock).not.toHaveBeenCalled();
  });

  it("pointerleave cancels a pending prefetch", async () => {
    const { result } = renderHook(() => useProjectSwitcherPalette());

    act(() => {
      result.current.onHoverProject("project-1", "mouse");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    act(() => {
      result.current.onHoverProjectEnd("mouse");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(prefetchHydrateMock).not.toHaveBeenCalled();
  });

  it("ignores non-mouse pointer types (touch, pen)", async () => {
    const { result } = renderHook(() => useProjectSwitcherPalette());

    act(() => {
      result.current.onHoverProject("project-1", "touch");
      result.current.onHoverProject("project-1", "pen");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(prefetchHydrateMock).not.toHaveBeenCalled();
  });

  it("does not prefetch the currently active project", async () => {
    projectState.currentProject = { id: "project-1" };
    const { result } = renderHook(() => useProjectSwitcherPalette());

    act(() => {
      result.current.onHoverProject("project-1", "mouse");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    expect(prefetchHydrateMock).not.toHaveBeenCalled();
  });

  it("coalesces concurrent hovers — a re-hover while in-flight does not refetch", async () => {
    let resolveFirst: (() => void) | null = null;
    prefetchHydrateMock.mockImplementationOnce(
      () =>
        new Promise<void>((r) => {
          resolveFirst = () => r();
        })
    );
    const { result } = renderHook(() => useProjectSwitcherPalette());

    act(() => {
      result.current.onHoverProject("project-1", "mouse");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    expect(prefetchHydrateMock).toHaveBeenCalledTimes(1);

    // Re-hover while the first request is still in flight (and the freshness
    // gate hasn't yet been written).
    act(() => {
      result.current.onHoverProjectEnd("mouse");
      result.current.onHoverProject("project-1", "mouse");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    expect(prefetchHydrateMock).toHaveBeenCalledTimes(1);

    resolveFirst!();
  });

  it("skips re-prefetch when the freshness gate is fresh (<15s)", async () => {
    const { result } = renderHook(() => useProjectSwitcherPalette());

    act(() => {
      result.current.onHoverProject("project-1", "mouse");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    // Let the prefetch promise settle and write the freshness timestamp.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(prefetchHydrateMock).toHaveBeenCalledTimes(1);

    // Less than 15s later, re-hover.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    act(() => {
      result.current.onHoverProjectEnd("mouse");
      result.current.onHoverProject("project-1", "mouse");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    expect(prefetchHydrateMock).toHaveBeenCalledTimes(1);
  });

  it("re-prefetches after the freshness window expires (>15s)", async () => {
    const { result } = renderHook(() => useProjectSwitcherPalette());

    act(() => {
      result.current.onHoverProject("project-1", "mouse");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(prefetchHydrateMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(16_000);
    });
    act(() => {
      result.current.onHoverProjectEnd("mouse");
      result.current.onHoverProject("project-1", "mouse");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    expect(prefetchHydrateMock).toHaveBeenCalledTimes(2);
  });

  it("clears the pending hover timer on palette close (isOpen → false)", async () => {
    const { result } = renderHook(() => useProjectSwitcherPalette());

    act(() => {
      result.current.open();
    });
    act(() => {
      result.current.onHoverProject("project-1", "mouse");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    act(() => {
      result.current.close();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(prefetchHydrateMock).not.toHaveBeenCalled();
  });

  it("hovering a second project before the first fires re-arms the timer", async () => {
    const { result } = renderHook(() => useProjectSwitcherPalette());

    act(() => {
      result.current.onHoverProject("project-1", "mouse");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    // Sweep to project-2 — the GitHubStatsToolbarButton pattern clears and
    // re-schedules the timer for the new target on each pointerenter.
    act(() => {
      result.current.onHoverProject("project-2", "mouse");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    expect(prefetchHydrateMock).toHaveBeenCalledTimes(1);
    expect(prefetchHydrateMock).toHaveBeenCalledWith("project-2");
  });
});
