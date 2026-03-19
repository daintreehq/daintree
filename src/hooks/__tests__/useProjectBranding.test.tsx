// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

    const { result } = renderHook(() => useProjectBranding("project-1"));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.projectIconSvg).toBeUndefined();
    expect(getSettingsMock).toHaveBeenCalledTimes(1);

    // Mount again — should not re-fetch
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

  it("cleans up pendingFetches on error so retry is possible", async () => {
    getSettingsMock.mockRejectedValueOnce(new Error("network error"));

    const { result } = renderHook(() => useProjectBranding("project-1"));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    // Should have cached undefined on error
    expect(result.current.projectIconSvg).toBeUndefined();

    // After invalidation, should retry
    getSettingsMock.mockResolvedValueOnce({ projectIconSvg: "<svg>recovered</svg>" });

    act(() => {
      invalidateBrandingCache("project-1");
    });

    await waitFor(() => {
      expect(result.current.projectIconSvg).toBe("<svg>recovered</svg>");
    });
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
});
