// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useSystemHealthCheck } from "../useSystemHealthCheck";

vi.mock("@/clients", () => ({
  systemClient: {
    getHealthCheckSpecs: vi.fn(),
    checkTool: vi.fn(),
  },
}));

import { systemClient } from "@/clients";

const mockGetSpecs = systemClient.getHealthCheckSpecs as ReturnType<typeof vi.fn>;
const mockCheckTool = systemClient.checkTool as ReturnType<typeof vi.fn>;

function makeSpec(tool: string, severity: "fatal" | "warn" | "silent" = "fatal") {
  return {
    tool,
    label: tool,
    severity,
    minVersion: null,
    installUrl: null,
    installBlocks: [],
  };
}

function makeResult(tool: string) {
  return {
    tool,
    label: tool,
    available: true,
    version: "1.0.0",
    severity: "fatal" as const,
    meetsMinVersion: true,
    minVersion: null,
    installUrl: null,
    installBlocks: [],
  };
}

describe("useSystemHealthCheck — focus re-check", () => {
  beforeEach(() => {
    mockGetSpecs.mockReset();
    mockCheckTool.mockReset();
    mockGetSpecs.mockResolvedValue([makeSpec("git")]);
    mockCheckTool.mockResolvedValue(makeResult("git"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("re-runs the check when the window regains focus", async () => {
    renderHook(() => useSystemHealthCheck());

    await waitFor(() => {
      expect(mockGetSpecs).toHaveBeenCalledTimes(1);
    });

    vi.spyOn(document, "hasFocus").mockReturnValue(true);

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

    await waitFor(() => {
      expect(mockGetSpecs).toHaveBeenCalledTimes(2);
    });
  });

  it("does not re-run when document.hasFocus() is false (inter-view switch)", async () => {
    renderHook(() => useSystemHealthCheck());

    await waitFor(() => {
      expect(mockGetSpecs).toHaveBeenCalledTimes(1);
    });

    vi.spyOn(document, "hasFocus").mockReturnValue(false);

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

    expect(mockGetSpecs).toHaveBeenCalledTimes(1);
  });

  it("removes the focus listener on unmount", async () => {
    const removeWinListenerSpy = vi.spyOn(window, "removeEventListener");

    const { unmount } = renderHook(() => useSystemHealthCheck());

    await waitFor(() => {
      expect(mockGetSpecs).toHaveBeenCalledTimes(1);
    });

    unmount();

    expect(removeWinListenerSpy).toHaveBeenCalledWith("focus", expect.any(Function));
  });

  it("preserves prior specs and checkStates across a re-check until new specs resolve", async () => {
    // First check resolves normally with git available.
    mockGetSpecs.mockResolvedValueOnce([makeSpec("git")]);
    mockCheckTool.mockResolvedValueOnce(makeResult("git"));

    const { result } = renderHook(() => useSystemHealthCheck());

    await waitFor(() => {
      expect(result.current.checkStates.git).toMatchObject({ available: true });
    });

    // Second check: pause getHealthCheckSpecs so we can observe state mid-flight.
    let resolveSpecs: (value: unknown) => void;
    const pendingSpecs = new Promise((resolve) => {
      resolveSpecs = resolve;
    });
    mockGetSpecs.mockReturnValueOnce(pendingSpecs);
    mockCheckTool.mockResolvedValueOnce(makeResult("git"));

    vi.spyOn(document, "hasFocus").mockReturnValue(true);

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

    // Mid-flight (specs not yet resolved): prior data must still be visible.
    expect(result.current.specs).toHaveLength(1);
    expect(result.current.specs[0]?.tool).toBe("git");
    expect(result.current.checkStates.git).toMatchObject({ available: true });

    // Resolve the second specs call and let the check settle.
    await act(async () => {
      resolveSpecs!([makeSpec("git")]);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(result.current.checkStates.git).toMatchObject({ available: true });
      expect(result.current.isChecking).toBe(false);
    });
  });

  it("preserves prior checkStates while checkTool reruns for tools still in the spec list", async () => {
    // First check completes with git available.
    mockGetSpecs.mockResolvedValueOnce([makeSpec("git")]);
    mockCheckTool.mockResolvedValueOnce(makeResult("git"));

    const { result } = renderHook(() => useSystemHealthCheck());

    await waitFor(() => {
      expect(result.current.checkStates.git).toMatchObject({ available: true });
      expect(result.current.isChecking).toBe(false);
    });

    // Second check: getHealthCheckSpecs resolves immediately with the same
    // spec list, but checkTool stays pending so we can observe the per-card
    // window between specs resolving and tools reporting.
    mockGetSpecs.mockResolvedValueOnce([makeSpec("git")]);
    let resolveTool: (value: unknown) => void;
    const pendingTool = new Promise((resolve) => {
      resolveTool = resolve;
    });
    mockCheckTool.mockReturnValueOnce(pendingTool);

    vi.spyOn(document, "hasFocus").mockReturnValue(true);

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

    // Specs have re-resolved. While checkTool is still pending, the prior
    // resolved result must remain in checkStates — not flash back to loading.
    await waitFor(() => {
      expect(mockGetSpecs).toHaveBeenCalledTimes(2);
    });
    expect(result.current.checkStates.git).toMatchObject({ available: true });

    // Let the tool result resolve and the check settle.
    await act(async () => {
      resolveTool!(makeResult("git"));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(result.current.isChecking).toBe(false);
    });
  });

  it("drops checkStates entries for tools removed from the spec list on re-check", async () => {
    // First check has git + node. Both available.
    mockGetSpecs.mockResolvedValueOnce([makeSpec("git"), makeSpec("node")]);
    mockCheckTool.mockResolvedValueOnce(makeResult("git"));
    mockCheckTool.mockResolvedValueOnce(makeResult("node"));

    const { result } = renderHook(() => useSystemHealthCheck());

    await waitFor(() => {
      expect(result.current.checkStates.git).toMatchObject({ available: true });
      expect(result.current.checkStates.node).toMatchObject({ available: true });
    });

    // Second check returns only git — node is gone from the spec list.
    mockGetSpecs.mockResolvedValueOnce([makeSpec("git")]);
    mockCheckTool.mockResolvedValueOnce(makeResult("git"));

    vi.spyOn(document, "hasFocus").mockReturnValue(true);

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

    await waitFor(() => {
      expect(mockGetSpecs).toHaveBeenCalledTimes(2);
      expect(result.current.checkStates.node).toBeUndefined();
      expect(result.current.checkStates.git).toMatchObject({ available: true });
    });
  });

  it("does not start a parallel check if one is already in flight (isCheckingRef guard)", async () => {
    let resolveSpecs: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      resolveSpecs = resolve;
    });
    mockGetSpecs.mockReturnValueOnce(pending);

    renderHook(() => useSystemHealthCheck());

    // Mount kicks off the first check; it stays pending.
    expect(mockGetSpecs).toHaveBeenCalledTimes(1);

    vi.spyOn(document, "hasFocus").mockReturnValue(true);

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

    // Focus event must not start a second check while the first is still pending.
    expect(mockGetSpecs).toHaveBeenCalledTimes(1);

    // Let the first check resolve so the test does not leak a pending promise.
    resolveSpecs!([makeSpec("git")]);
    await act(async () => {
      await Promise.resolve();
    });
  });
});
