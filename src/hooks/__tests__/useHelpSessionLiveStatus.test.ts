// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HelpSessionLiveStatus } from "@shared/types";

vi.mock("@/utils/logger", () => ({ logError: vi.fn() }));

import { logError } from "@/utils/logger";
import { useHelpSessionLiveStatus } from "../useHelpSessionLiveStatus";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const DISCONNECTED: HelpSessionLiveStatus = {
  connected: false,
  tier: "workbench",
  activeGrants: [],
};

const CONNECTED: HelpSessionLiveStatus = {
  connected: true,
  tier: "action",
  activeGrants: [],
};

let pulls: Array<Deferred<HelpSessionLiveStatus>>;
let getLiveSessionStatus: ReturnType<typeof vi.fn>;
let onGrantLifecycle: ReturnType<typeof vi.fn>;
let unsubscribe: ReturnType<typeof vi.fn>;
let grantCallback: (() => void) | null;

beforeEach(() => {
  pulls = [];
  grantCallback = null;
  unsubscribe = vi.fn();
  getLiveSessionStatus = vi.fn(() => {
    const d = deferred<HelpSessionLiveStatus>();
    pulls.push(d);
    return d.promise;
  });
  onGrantLifecycle = vi.fn((cb: () => void) => {
    grantCallback = cb;
    return unsubscribe;
  });
  (window as unknown as { electron: unknown }).electron = {
    helpAssistant: { getLiveSessionStatus },
    mcpServer: { onGrantLifecycle },
  };
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("useHelpSessionLiveStatus", () => {
  it("returns disconnected defaults and does no IPC when sessionId is null", () => {
    const { result } = renderHook(() => useHelpSessionLiveStatus(null));

    expect(result.current).toEqual(DISCONNECTED);
    expect(onGrantLifecycle).not.toHaveBeenCalled();
    expect(getLiveSessionStatus).not.toHaveBeenCalled();
  });

  it("subscribes to the grant-lifecycle push BEFORE the first pull", () => {
    renderHook(() => useHelpSessionLiveStatus("help-1"));

    expect(onGrantLifecycle).toHaveBeenCalledTimes(1);
    expect(getLiveSessionStatus).toHaveBeenCalledWith({ sessionId: "help-1" });
    // Ordering matters: a push arriving in the mount→pull gap must not be missed.
    expect(onGrantLifecycle.mock.invocationCallOrder[0]!).toBeLessThan(
      getLiveSessionStatus.mock.invocationCallOrder[0]!
    );
  });

  it("populates state from the resolved pull", async () => {
    const { result } = renderHook(() => useHelpSessionLiveStatus("help-1"));

    await act(async () => {
      pulls[0]!.resolve(CONNECTED);
    });

    await waitFor(() => expect(result.current).toEqual(CONNECTED));
  });

  it("re-pulls when a grant-lifecycle event fires", async () => {
    renderHook(() => useHelpSessionLiveStatus("help-1"));
    await act(async () => {
      pulls[0]!.resolve(CONNECTED);
    });

    act(() => {
      grantCallback?.();
    });

    expect(getLiveSessionStatus).toHaveBeenCalledTimes(2);
  });

  it("propagates the fresh snapshot from a re-pull into state", async () => {
    const { result } = renderHook(() => useHelpSessionLiveStatus("help-1"));
    await act(async () => {
      pulls[0]!.resolve(CONNECTED);
    });

    act(() => {
      grantCallback?.();
    });
    const withGrant: HelpSessionLiveStatus = {
      connected: true,
      tier: "action",
      activeGrants: [{ toolId: "git.push", expiresAt: 1_700_000_000_000, ttlMs: 900_000 }],
    };
    await act(async () => {
      pulls[1]!.resolve(withGrant);
    });

    // Not just that a second pull fired — the hook must surface its result.
    await waitFor(() => expect(result.current.activeGrants).toHaveLength(1));
    expect(result.current.activeGrants[0]?.toolId).toBe("git.push");
  });

  it("falls back to disconnected defaults and logs when the pull rejects", async () => {
    const { result } = renderHook(() => useHelpSessionLiveStatus("help-1"));

    await act(async () => {
      pulls[0]!.reject(new Error("bridge down"));
    });

    await waitFor(() => expect(result.current).toEqual(DISCONNECTED));
    expect(vi.mocked(logError)).toHaveBeenCalled();
  });

  it("coalesces a burst of events during an in-flight pull into one trailing re-pull", async () => {
    renderHook(() => useHelpSessionLiveStatus("help-1"));
    // pull #1 is still pending — events should not each spawn their own pull.
    act(() => {
      grantCallback?.();
      grantCallback?.();
      grantCallback?.();
    });
    expect(getLiveSessionStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      pulls[0]!.resolve(CONNECTED);
    });
    // Exactly one trailing pull folds in every event that arrived mid-flight.
    expect(getLiveSessionStatus).toHaveBeenCalledTimes(2);

    await act(async () => {
      pulls[1]!.resolve(CONNECTED);
    });
    expect(getLiveSessionStatus).toHaveBeenCalledTimes(2);
  });

  it("unsubscribes on unmount and ignores a late-resolving pull", async () => {
    const { result, unmount } = renderHook(() => useHelpSessionLiveStatus("help-1"));
    unmount();

    expect(unsubscribe).toHaveBeenCalledTimes(1);

    await act(async () => {
      pulls[0]!.resolve(CONNECTED);
    });
    // The pull never resolved before unmount, and the cancelled guard drops the
    // late resolution — state stays at the initial disconnected snapshot.
    expect(result.current).toEqual(DISCONNECTED);
  });

  it("re-subscribes and pulls with the new id when sessionId changes", async () => {
    const { rerender } = renderHook(({ id }) => useHelpSessionLiveStatus(id), {
      initialProps: { id: "help-1" as string | null },
    });
    await act(async () => {
      pulls[0]!.resolve(CONNECTED);
    });

    rerender({ id: "help-2" });

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(getLiveSessionStatus).toHaveBeenLastCalledWith({ sessionId: "help-2" });
    expect(onGrantLifecycle).toHaveBeenCalledTimes(2);
  });
});
