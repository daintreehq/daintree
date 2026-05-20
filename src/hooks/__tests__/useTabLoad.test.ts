// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useTabLoad } from "../useTabLoad";

afterEach(() => {
  vi.useRealTimers();
});

describe("useTabLoad", () => {
  it("starts in the loading state", () => {
    const initialize = vi.fn(() => new Promise<void>(() => {}));
    const { result } = renderHook(() => useTabLoad({ initialize }));
    expect(result.current.isLoading).toBe(true);
    expect(result.current.loadError).toBeNull();
  });

  it("clears loading when initialize resolves", async () => {
    const initialize = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useTabLoad({ initialize }));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.loadError).toBeNull();
    expect(initialize).toHaveBeenCalledTimes(1);
  });

  it("sets loadError when initialize rejects", async () => {
    const initialize = vi.fn().mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => useTabLoad({ initialize }));

    await waitFor(() => expect(result.current.loadError).toBe("boom"));
    expect(result.current.isLoading).toBe(false);
  });

  it("uses errorMessage fallback when the rejection carries no message", async () => {
    const initialize = vi.fn().mockRejectedValue(undefined);
    const { result } = renderHook(() =>
      useTabLoad({ initialize, errorMessage: "Couldn't load tab" })
    );

    await waitFor(() => expect(result.current.loadError).toBe("Couldn't load tab"));
  });

  it("times out after timeoutMs with the timeoutMessage", async () => {
    vi.useFakeTimers();
    const initialize = vi.fn(() => new Promise<void>(() => {}));
    const { result } = renderHook(() =>
      useTabLoad({ initialize, timeoutMs: 100, timeoutMessage: "Timed out" })
    );

    await act(async () => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current.isLoading).toBe(false);
    expect(result.current.loadError).toBe("Timed out");
  });

  it("does not time out when initialize resolves first", async () => {
    vi.useFakeTimers();
    const initialize = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useTabLoad({ initialize, timeoutMs: 100 }));

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.isLoading).toBe(false);
    expect(result.current.loadError).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    expect(result.current.loadError).toBeNull();
  });

  it("retryAction calls retry, not initialize", async () => {
    const initialize = vi.fn().mockResolvedValue(undefined);
    const retry = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useTabLoad({ initialize, retry }));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();

    act(() => {
      result.current.retryAction();
    });
    await waitFor(() => expect(retry).toHaveBeenCalledTimes(1));
    expect(initialize).toHaveBeenCalledTimes(1);
  });

  it("retryAction falls back to initialize when retry is not provided", async () => {
    const initialize = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useTabLoad({ initialize }));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(initialize).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.retryAction();
    });
    await waitFor(() => expect(initialize).toHaveBeenCalledTimes(2));
  });

  it("clears the error and re-enters the loading state on retry", async () => {
    const initialize = vi.fn().mockRejectedValueOnce(new Error("oh no"));
    const retry = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useTabLoad({ initialize, retry }));

    await waitFor(() => expect(result.current.loadError).toBe("oh no"));

    act(() => {
      result.current.retryAction();
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.loadError).toBeNull();
  });

  it("discards a stale resolution after a retry has fired", async () => {
    let resolveFirst: (() => void) | undefined;
    const initialize = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveFirst = resolve;
        })
    );
    const retry = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useTabLoad({ initialize, retry }));

    act(() => {
      result.current.retryAction();
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      resolveFirst?.();
      await Promise.resolve();
    });
    expect(result.current.loadError).toBeNull();
  });

  it("does not update state after unmount", async () => {
    vi.useFakeTimers();
    const initialize = vi.fn(() => new Promise<void>(() => {}));
    const { unmount } = renderHook(() =>
      useTabLoad({ initialize, timeoutMs: 50 })
    );
    unmount();
    expect(() => {
      act(() => {
        vi.advanceTimersByTime(500);
      });
    }).not.toThrow();
  });
});
