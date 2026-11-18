// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getSettingsMock = vi.hoisted(() => vi.fn());

const { projectState, useProjectStoreMock } = vi.hoisted(() => {
  const projectState = {
    currentProject: { id: "project-1" } as { id: string } | null,
  };

  const useProjectStoreMock = vi.fn((selector: (s: typeof projectState) => unknown) =>
    selector(projectState)
  );

  return { projectState, useProjectStoreMock };
});

vi.mock("@/clients", () => ({
  projectClient: {
    getSettings: getSettingsMock,
  },
}));

vi.mock("@/store/projectStore", () => ({
  useProjectStore: useProjectStoreMock,
}));

import {
  useProjectBranding,
  invalidateBrandingCache,
  updateBrandingCache,
} from "../useProjectBranding";

describe("useProjectBranding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSettingsMock.mockReset();
    invalidateBrandingCache();
    projectState.currentProject = { id: "project-1" };
  });

  it("fetches branding on first mount and returns SVG", async () => {
    getSettingsMock.mockResolvedValueOnce({ projectIconSvg: "<svg>icon</svg>" });

    const { result } = renderHook(() => useProjectBranding());

    expect(result.current.isLoading).toBe(true);

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.projectIconSvg).toBe("<svg>icon</svg>");
    expect(getSettingsMock).toHaveBeenCalledTimes(1);
    expect(getSettingsMock).toHaveBeenCalledWith("project-1");
  });

  it("deduplicates concurrent mounts — only one IPC call for same projectId", async () => {
    let resolveSettings: (v: { projectIconSvg?: string }) => void;
    getSettingsMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSettings = resolve;
      })
    );

    const { result: result1 } = renderHook(() => useProjectBranding("project-1"));
    const { result: result2 } = renderHook(() => useProjectBranding("project-1"));

    expect(result1.current.isLoading).toBe(true);
    expect(result2.current.isLoading).toBe(true);
    expect(getSettingsMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveSettings!({ projectIconSvg: "<svg>shared</svg>" });
    });

    await waitFor(() => {
      expect(result1.current.isLoading).toBe(false);
    });

    expect(result1.current.projectIconSvg).toBe("<svg>shared</svg>");
    expect(result2.current.projectIconSvg).toBe("<svg>shared</svg>");
    expect(getSettingsMock).toHaveBeenCalledTimes(1);
  });

  it("returns cached SVG instantly on subsequent mount with no IPC call", async () => {
    getSettingsMock.mockResolvedValueOnce({ projectIconSvg: "<svg>cached</svg>" });

    const { result: first, unmount } = renderHook(() => useProjectBranding("project-1"));

    await waitFor(() => {
      expect(first.current.isLoading).toBe(false);
    });
    expect(first.current.projectIconSvg).toBe("<svg>cached</svg>");

    unmount();
    getSettingsMock.mockClear();

    const { result: second } = renderHook(() => useProjectBranding("project-1"));

    expect(second.current.projectIconSvg).toBe("<svg>cached</svg>");
    expect(second.current.isLoading).toBe(false);
    expect(getSettingsMock).not.toHaveBeenCalled();
  });

  it("caches undefined projectIconSvg correctly (no icon configured)", async () => {
    getSettingsMock.mockResolvedValueOnce({ projectIconSvg: undefined });

    const { result, unmount } = renderHook(() => useProjectBranding("project-1"));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.projectIconSvg).toBeUndefined();
    expect(getSettingsMock).toHaveBeenCalledTimes(1);

    // Mount again — should not re-fetch
    unmount();
    getSettingsMock.mockClear();
    const { result: second } = renderHook(() => useProjectBranding("project-1"));
    expect(second.current.isLoading).toBe(false);
    expect(getSettingsMock).not.toHaveBeenCalled();
  });

  it("updateBrandingCache propagates new SVG to mounted subscribers without IPC", async () => {
    getSettingsMock.mockResolvedValueOnce({ projectIconSvg: "<svg>old</svg>" });

    const { result } = renderHook(() => useProjectBranding("project-1"));

    await waitFor(() => {
      expect(result.current.projectIconSvg).toBe("<svg>old</svg>");
    });

    getSettingsMock.mockClear();

    act(() => {
      updateBrandingCache("project-1", "<svg>new</svg>");
    });

    expect(result.current.projectIconSvg).toBe("<svg>new</svg>");
    expect(getSettingsMock).not.toHaveBeenCalled();
  });

  it("invalidateBrandingCache() clears all and triggers re-fetch", async () => {
    getSettingsMock.mockResolvedValueOnce({ projectIconSvg: "<svg>first</svg>" });

    const { result } = renderHook(() => useProjectBranding("project-1"));

    await waitFor(() => {
      expect(result.current.projectIconSvg).toBe("<svg>first</svg>");
    });

    getSettingsMock.mockResolvedValueOnce({ projectIconSvg: "<svg>refetched</svg>" });

    act(() => {
      invalidateBrandingCache();
    });

    await waitFor(() => {
      expect(result.current.projectIconSvg).toBe("<svg>refetched</svg>");
    });

    expect(getSettingsMock).toHaveBeenCalledTimes(2);
  });

  it("invalidateBrandingCache(projectId) only clears that specific entry", async () => {
    getSettingsMock
      .mockResolvedValueOnce({ projectIconSvg: "<svg>p1</svg>" })
      .mockResolvedValueOnce({ projectIconSvg: "<svg>p2</svg>" });

    const { result: r1 } = renderHook(() => useProjectBranding("project-1"));
    const { result: r2 } = renderHook(() => useProjectBranding("project-2"));

    await waitFor(() => {
      expect(r1.current.projectIconSvg).toBe("<svg>p1</svg>");
    });
    await waitFor(() => {
      expect(r2.current.projectIconSvg).toBe("<svg>p2</svg>");
    });

    getSettingsMock.mockResolvedValueOnce({ projectIconSvg: "<svg>p1-new</svg>" });

    act(() => {
      invalidateBrandingCache("project-1");
    });

    await waitFor(() => {
      expect(r1.current.projectIconSvg).toBe("<svg>p1-new</svg>");
    });

    // project-2 should remain cached
    expect(r2.current.projectIconSvg).toBe("<svg>p2</svg>");
  });

  it("returns undefined with isLoading false when no targetId", () => {
    projectState.currentProject = null;

    const { result } = renderHook(() => useProjectBranding());

    expect(result.current.projectIconSvg).toBeUndefined();
    expect(result.current.isLoading).toBe(false);
    expect(getSettingsMock).not.toHaveBeenCalled();
  });

  it("stale fetch does not overwrite write-through value", async () => {
    let resolveSettings: (v: { projectIconSvg?: string }) => void;
    getSettingsMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSettings = resolve;
      })
    );

    const { result } = renderHook(() => useProjectBranding("project-1"));
    expect(result.current.isLoading).toBe(true);

    // Write-through while fetch is in-flight
    act(() => {
      updateBrandingCache("project-1", "<svg>write-through</svg>");
    });

    expect(result.current.projectIconSvg).toBe("<svg>write-through</svg>");
    expect(result.current.isLoading).toBe(false);

    // Stale fetch resolves — should NOT overwrite
    await act(async () => {
      resolveSettings!({ projectIconSvg: "<svg>stale</svg>" });
    });

    expect(result.current.projectIconSvg).toBe("<svg>write-through</svg>");
  });

  it("stale fetch does not corrupt cache after invalidation + new fetch", async () => {
    let resolveFirst: (v: { projectIconSvg?: string }) => void;
    getSettingsMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFirst = resolve;
      })
    );

    const { result } = renderHook(() => useProjectBranding("project-1"));
    expect(result.current.isLoading).toBe(true);

    // Invalidate while first fetch is in-flight, triggering a new fetch
    getSettingsMock.mockResolvedValueOnce({ projectIconSvg: "<svg>fresh</svg>" });

    act(() => {
      invalidateBrandingCache("project-1");
    });

    // Wait for the second (fresh) fetch to complete
    await waitFor(() => {
      expect(result.current.projectIconSvg).toBe("<svg>fresh</svg>");
    });

    // Now the stale first fetch resolves — should NOT corrupt cache
    await act(async () => {
      resolveFirst!({ projectIconSvg: "<svg>stale</svg>" });
    });

    expect(result.current.projectIconSvg).toBe("<svg>fresh</svg>");
  });

  describe("transient read failures", () => {
    const revealListeners = new Set<() => void>();

    beforeEach(() => {
      vi.useFakeTimers();
      revealListeners.clear();
      Object.defineProperty(window, "electron", {
        configurable: true,
        value: {
          app: {
            onViewRevealed: (cb: () => void) => {
              revealListeners.add(cb);
              return () => revealListeners.delete(cb);
            },
          },
        },
      });
    });

    afterEach(() => {
      cleanup();
      invalidateBrandingCache();
      vi.useRealTimers();
      delete (window as { electron?: unknown }).electron;
    });

    const advance = (ms: number) =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });

    // Steps through each retry delay, checking no read lands a tick early.
    const stepThroughRetries = async (firstCall: number) => {
      let calls = firstCall;
      for (const delay of [250, 1000, 3000]) {
        await advance(delay - 1);
        expect(getSettingsMock).toHaveBeenCalledTimes(calls);
        await advance(1);
        expect(getSettingsMock).toHaveBeenCalledTimes(++calls);
      }
    };

    const exhaustRetries = async () => {
      getSettingsMock.mockRejectedValue(new Error("unreadable"));
      const hook = renderHook(() => useProjectBranding("project-1"));
      await advance(0);
      expect(getSettingsMock).toHaveBeenCalledTimes(1);
      await stepThroughRetries(1);
      return hook;
    };

    // Three more failures then a success: a rearm that granted less than a full
    // budget would give up before the fourth read.
    const queueFullBudgetRecovery = (svg: string) => {
      getSettingsMock.mockReset();
      getSettingsMock
        .mockRejectedValueOnce(new Error("still down"))
        .mockRejectedValueOnce(new Error("still down"))
        .mockRejectedValueOnce(new Error("still down"))
        .mockResolvedValueOnce({ projectIconSvg: svg });
    };

    it("retries a failed read and shows the saved icon without a settings edit", async () => {
      getSettingsMock
        .mockRejectedValueOnce(new Error("transient"))
        .mockResolvedValueOnce({ projectIconSvg: "<svg>saved</svg>" });

      const { result } = renderHook(() => useProjectBranding("project-1"));
      await advance(0);

      expect(getSettingsMock).toHaveBeenCalledTimes(1);
      expect(result.current.projectIconSvg).toBeUndefined();
      expect(result.current.isLoading).toBe(false);

      await advance(249);
      expect(getSettingsMock).toHaveBeenCalledTimes(1);

      await advance(1);
      expect(getSettingsMock).toHaveBeenCalledTimes(2);
      expect(result.current.projectIconSvg).toBe("<svg>saved</svg>");
      expect(vi.getTimerCount()).toBe(0);
    });

    it("stops after the bounded retries, even across rerenders and cache notifications", async () => {
      const { result, rerender } = await exhaustRetries();

      expect(result.current.projectIconSvg).toBeUndefined();
      expect(result.current.isLoading).toBe(false);
      expect(vi.getTimerCount()).toBe(0);

      await advance(60_000);
      rerender();
      act(() => {
        updateBrandingCache("project-2", "<svg>other</svg>");
      });
      await advance(0);

      expect(getSettingsMock).toHaveBeenCalledTimes(4);
    });

    it("gives a fresh budget on remount once retries ran out", async () => {
      const { unmount } = await exhaustRetries();
      unmount();
      queueFullBudgetRecovery("<svg>recovered</svg>");

      const { result } = renderHook(() => useProjectBranding("project-1"));
      await advance(0);
      expect(getSettingsMock).toHaveBeenCalledTimes(1);

      await stepThroughRetries(1);
      expect(result.current.projectIconSvg).toBe("<svg>recovered</svg>");
    });

    it("gives a fresh budget when the project view is revealed again", async () => {
      const { result } = await exhaustRetries();
      queueFullBudgetRecovery("<svg>revealed</svg>");

      act(() => {
        revealListeners.forEach((cb) => cb());
      });
      await advance(0);
      expect(getSettingsMock).toHaveBeenCalledTimes(1);

      await stepThroughRetries(1);
      expect(result.current.projectIconSvg).toBe("<svg>revealed</svg>");
    });

    it("keeps the scheduled retry's deadline when the view is revealed mid-wait", async () => {
      getSettingsMock
        .mockRejectedValueOnce(new Error("transient"))
        .mockResolvedValueOnce({ projectIconSvg: "<svg>on-time</svg>" });

      const { result } = renderHook(() => useProjectBranding("project-1"));
      await advance(100);
      expect(getSettingsMock).toHaveBeenCalledTimes(1);

      act(() => {
        revealListeners.forEach((cb) => cb());
      });
      await advance(149);
      expect(getSettingsMock).toHaveBeenCalledTimes(1);

      await advance(1);
      expect(getSettingsMock).toHaveBeenCalledTimes(2);
      expect(result.current.projectIconSvg).toBe("<svg>on-time</svg>");
    });

    it("does not read while unmounted, and reads once a consumer mounts again", async () => {
      getSettingsMock.mockRejectedValueOnce(new Error("transient"));

      const { unmount } = renderHook(() => useProjectBranding("project-1"));
      await advance(0);
      unmount();

      await advance(10_000);
      expect(getSettingsMock).toHaveBeenCalledTimes(1);
      expect(revealListeners.size).toBe(0);

      getSettingsMock.mockResolvedValueOnce({ projectIconSvg: "<svg>back</svg>" });
      const { result } = renderHook(() => useProjectBranding("project-1"));
      await advance(0);

      expect(getSettingsMock).toHaveBeenCalledTimes(2);
      expect(result.current.projectIconSvg).toBe("<svg>back</svg>");
    });

    it("keeps a successful no-icon read cached with no retry scheduled", async () => {
      getSettingsMock.mockResolvedValueOnce({ projectIconSvg: undefined });

      const { unmount } = renderHook(() => useProjectBranding("project-1"));
      await advance(0);
      unmount();

      expect(vi.getTimerCount()).toBe(0);

      const { result } = renderHook(() => useProjectBranding("project-1"));
      await advance(10_000);

      expect(result.current.projectIconSvg).toBeUndefined();
      expect(result.current.isLoading).toBe(false);
      expect(getSettingsMock).toHaveBeenCalledTimes(1);
    });

    it("cancels a scheduled retry when settings write the icon through", async () => {
      getSettingsMock.mockRejectedValueOnce(new Error("transient"));

      const { result } = renderHook(() => useProjectBranding("project-1"));
      await advance(0);
      expect(vi.getTimerCount()).toBe(1);

      act(() => {
        updateBrandingCache("project-1", undefined);
      });
      expect(vi.getTimerCount()).toBe(0);
      await advance(10_000);

      expect(getSettingsMock).toHaveBeenCalledTimes(1);
      expect(result.current.projectIconSvg).toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("reads immediately after invalidation instead of waiting out the retry delay", async () => {
      getSettingsMock
        .mockRejectedValueOnce(new Error("transient"))
        .mockResolvedValueOnce({ projectIconSvg: "<svg>fresh</svg>" });

      const { result } = renderHook(() => useProjectBranding("project-1"));
      await advance(0);
      expect(vi.getTimerCount()).toBe(1);

      act(() => {
        invalidateBrandingCache("project-1");
      });
      expect(vi.getTimerCount()).toBe(0);
      await advance(0);

      expect(getSettingsMock).toHaveBeenCalledTimes(2);
      expect(result.current.projectIconSvg).toBe("<svg>fresh</svg>");

      await advance(10_000);
      expect(getSettingsMock).toHaveBeenCalledTimes(2);
    });

    it("cancels every project's scheduled retry on a global invalidation", async () => {
      getSettingsMock
        .mockRejectedValueOnce(new Error("transient"))
        .mockRejectedValueOnce(new Error("transient"))
        .mockResolvedValueOnce({ projectIconSvg: "<svg>p1</svg>" })
        .mockResolvedValueOnce({ projectIconSvg: "<svg>p2</svg>" });

      const { result: r1 } = renderHook(() => useProjectBranding("project-1"));
      const { result: r2 } = renderHook(() => useProjectBranding("project-2"));
      await advance(0);
      expect(getSettingsMock).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(2);

      act(() => {
        invalidateBrandingCache();
      });
      expect(vi.getTimerCount()).toBe(0);
      await advance(0);

      expect(getSettingsMock).toHaveBeenCalledTimes(4);
      expect(r1.current.projectIconSvg).toBe("<svg>p1</svg>");
      expect(r2.current.projectIconSvg).toBe("<svg>p2</svg>");

      await advance(10_000);
      expect(getSettingsMock).toHaveBeenCalledTimes(4);
    });

    it("ignores a stale rejection that lands after a newer read started", async () => {
      let rejectFirst: (err: Error) => void;
      getSettingsMock.mockReturnValueOnce(
        new Promise((_, reject) => {
          rejectFirst = reject;
        })
      );
      let resolveSecond: (v: { projectIconSvg?: string }) => void;
      getSettingsMock.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveSecond = resolve;
        })
      );

      const { result } = renderHook(() => useProjectBranding("project-1"));
      act(() => {
        invalidateBrandingCache("project-1");
      });
      expect(getSettingsMock).toHaveBeenCalledTimes(2);

      await act(async () => {
        rejectFirst!(new Error("stale"));
      });

      expect(result.current.isLoading).toBe(true);
      expect(vi.getTimerCount()).toBe(0);

      await act(async () => {
        resolveSecond!({ projectIconSvg: "<svg>second</svg>" });
      });

      expect(result.current.projectIconSvg).toBe("<svg>second</svg>");
      expect(getSettingsMock).toHaveBeenCalledTimes(2);
    });
  });
});
