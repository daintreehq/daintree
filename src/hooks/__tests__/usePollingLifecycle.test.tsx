// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { onSwitchMock } = vi.hoisted(() => ({
  onSwitchMock: vi.fn<(cb: () => void) => () => void>(),
}));

vi.mock("@/clients", () => ({
  projectClient: {
    onSwitch: onSwitchMock,
  },
}));

import { usePollingLifecycle, _resetPollingLifecycleForTests } from "../usePollingLifecycle";

function createDeferred<T>() {
  let resolve: (value: T) => void;
  let reject: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve: resolve!, reject: reject! };
}

function setupHook(opts: {
  fetchFn?: (ctx: {
    force: boolean;
    fetchId: number;
    isInvalidated: () => boolean;
  }) => Promise<void>;
  calculateNextInterval?: (ctx: { isVisible: boolean }) => number;
  onProjectSwitch?: () => void;
}) {
  const fetchFn = opts.fetchFn ?? vi.fn().mockResolvedValue(undefined);
  const calculateNextInterval = opts.calculateNextInterval ?? (() => 30_000);
  const onProjectSwitch = opts.onProjectSwitch ?? vi.fn();
  const hook = renderHook(() =>
    usePollingLifecycle({
      fetchFn,
      calculateNextInterval,
      onProjectSwitch,
    })
  );
  return { hook, fetchFn, calculateNextInterval, onProjectSwitch };
}

describe("usePollingLifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetPollingLifecycleForTests();
    onSwitchMock.mockReturnValue(() => {});
  });

  describe("singleton listener registration", () => {
    it("installs visibilitychange / sidebar-refresh / project-switch listeners on first subscriber", () => {
      const addEventListenerSpy = vi.spyOn(document, "addEventListener");
      const windowAddEventListenerSpy = vi.spyOn(window, "addEventListener");

      setupHook({});

      expect(addEventListenerSpy).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
      expect(windowAddEventListenerSpy).toHaveBeenCalledWith(
        "daintree:refresh-sidebar",
        expect.any(Function)
      );
      expect(onSwitchMock).toHaveBeenCalledTimes(1);

      addEventListenerSpy.mockRestore();
      windowAddEventListenerSpy.mockRestore();
    });

    it("installs each global listener only once across multiple mounted hooks", () => {
      const addEventListenerSpy = vi.spyOn(document, "addEventListener");

      setupHook({});
      setupHook({});
      setupHook({});

      const visibilityCalls = addEventListenerSpy.mock.calls.filter(
        ([event]) => event === "visibilitychange"
      );
      expect(visibilityCalls).toHaveLength(1);
      expect(onSwitchMock).toHaveBeenCalledTimes(1);

      addEventListenerSpy.mockRestore();
    });

    it("tears down listeners only on last subscriber unmount", () => {
      const projectSwitchCleanup = vi.fn();
      onSwitchMock.mockReturnValue(projectSwitchCleanup);
      const removeEventListenerSpy = vi.spyOn(document, "removeEventListener");

      const a = setupHook({});
      const b = setupHook({});

      a.hook.unmount();
      expect(projectSwitchCleanup).not.toHaveBeenCalled();
      const removeCallsAfterFirstUnmount = removeEventListenerSpy.mock.calls.filter(
        ([event]) => event === "visibilitychange"
      );
      expect(removeCallsAfterFirstUnmount).toHaveLength(0);

      b.hook.unmount();
      expect(projectSwitchCleanup).toHaveBeenCalledTimes(1);
      const removeCallsAfterSecondUnmount = removeEventListenerSpy.mock.calls.filter(
        ([event]) => event === "visibilitychange"
      );
      expect(removeCallsAfterSecondUnmount).toHaveLength(1);

      removeEventListenerSpy.mockRestore();
    });
  });

  describe("initial fetch and scheduling", () => {
    it("calls fetchFn once on mount", async () => {
      const fetchFn = vi.fn().mockResolvedValue(undefined);
      setupHook({ fetchFn });

      await waitFor(() => {
        expect(fetchFn).toHaveBeenCalledTimes(1);
        expect(fetchFn.mock.calls[0]?.[0]?.force).toBe(false);
      });
    });

    it("invokes calculateNextInterval after the fetch resolves", async () => {
      const calculateNextInterval = vi.fn().mockReturnValue(60_000);
      setupHook({ calculateNextInterval });

      await waitFor(() => {
        expect(calculateNextInterval).toHaveBeenCalled();
      });
    });
  });

  describe("global fan-out", () => {
    it("fans visibilitychange (visible) to all subscribers as a fetch + reschedule", async () => {
      const fetchA = vi.fn().mockResolvedValue(undefined);
      const fetchB = vi.fn().mockResolvedValue(undefined);
      setupHook({ fetchFn: fetchA });
      setupHook({ fetchFn: fetchB });

      await waitFor(() => {
        expect(fetchA).toHaveBeenCalledTimes(1);
        expect(fetchB).toHaveBeenCalledTimes(1);
      });

      Object.defineProperty(document, "hidden", { value: false, configurable: true });
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(fetchA).toHaveBeenCalledTimes(2);
        expect(fetchB).toHaveBeenCalledTimes(2);
      });
    });

    it("fans daintree:refresh-sidebar to all subscribers as a forced refresh", async () => {
      const fetchA = vi.fn().mockResolvedValue(undefined);
      const fetchB = vi.fn().mockResolvedValue(undefined);
      setupHook({ fetchFn: fetchA });
      setupHook({ fetchFn: fetchB });

      await waitFor(() => {
        expect(fetchA).toHaveBeenCalledTimes(1);
        expect(fetchB).toHaveBeenCalledTimes(1);
      });

      await act(async () => {
        window.dispatchEvent(new CustomEvent("daintree:refresh-sidebar"));
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(fetchA).toHaveBeenCalledTimes(2);
        expect(fetchA.mock.calls[1]?.[0]?.force).toBe(true);
        expect(fetchB).toHaveBeenCalledTimes(2);
        expect(fetchB.mock.calls[1]?.[0]?.force).toBe(true);
      });
    });

    it("fans projectClient.onSwitch to all subscribers as onProjectSwitch + refetch", async () => {
      let captured: (() => void) | undefined;
      onSwitchMock.mockImplementation((cb) => {
        captured = cb;
        return () => {};
      });

      const onSwitchA = vi.fn();
      const onSwitchB = vi.fn();
      const fetchA = vi.fn().mockResolvedValue(undefined);
      const fetchB = vi.fn().mockResolvedValue(undefined);
      setupHook({ fetchFn: fetchA, onProjectSwitch: onSwitchA });
      setupHook({ fetchFn: fetchB, onProjectSwitch: onSwitchB });

      await waitFor(() => {
        expect(fetchA).toHaveBeenCalledTimes(1);
        expect(fetchB).toHaveBeenCalledTimes(1);
      });

      await act(async () => {
        captured?.();
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(onSwitchA).toHaveBeenCalledTimes(1);
        expect(onSwitchB).toHaveBeenCalledTimes(1);
        expect(fetchA).toHaveBeenCalledTimes(2);
        expect(fetchB).toHaveBeenCalledTimes(2);
      });
    });

    it("isolates per-subscriber failures so one consumer's throw cannot block siblings", async () => {
      // Suppress the expected console.error from the fan-out catch block so
      // it doesn't pollute test output.
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const onSwitchThrows = vi.fn(() => {
        throw new Error("subscriber A failed");
      });
      const onSwitchOk = vi.fn();
      const fetchA = vi.fn().mockResolvedValue(undefined);
      const fetchB = vi.fn().mockResolvedValue(undefined);

      let captured: (() => void) | undefined;
      onSwitchMock.mockImplementation((cb) => {
        captured = cb;
        return () => {};
      });

      setupHook({ fetchFn: fetchA, onProjectSwitch: onSwitchThrows });
      setupHook({ fetchFn: fetchB, onProjectSwitch: onSwitchOk });

      await waitFor(() => {
        expect(fetchA).toHaveBeenCalledTimes(1);
        expect(fetchB).toHaveBeenCalledTimes(1);
      });

      await act(async () => {
        captured?.();
        await Promise.resolve();
      });

      // A threw, but B's onProjectSwitch still ran.
      expect(onSwitchOk).toHaveBeenCalledTimes(1);
      consoleErrorSpy.mockRestore();
    });
  });

  describe("queue and invalidation", () => {
    it("queues a second fetch when the first is still in flight and drains it on resolve", async () => {
      const deferred = createDeferred<void>();
      let callCount = 0;
      const fetchFn = vi.fn().mockImplementation(async () => {
        callCount += 1;
        if (callCount === 1) await deferred.promise;
      });

      const { hook } = setupHook({ fetchFn });

      await waitFor(() => {
        expect(fetchFn).toHaveBeenCalledTimes(1);
      });

      // Trigger a sidebar refresh while the first fetch is still pending —
      // primitive should queue it without invoking fetchFn a second time.
      await act(async () => {
        window.dispatchEvent(new CustomEvent("daintree:refresh-sidebar"));
        await Promise.resolve();
      });

      expect(fetchFn).toHaveBeenCalledTimes(1);

      // Resolve the in-flight fetch — primitive must drain the queue.
      await act(async () => {
        deferred.resolve();
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(fetchFn).toHaveBeenCalledTimes(2);
        // Queued force flag must thread through to the drained fetch.
        expect(fetchFn.mock.calls[1]?.[0]?.force).toBe(true);
      });

      hook.unmount();
    });

    it("flags the in-flight fetchId as invalidated when a new fetch is queued", async () => {
      let firstInvalidatedAfter = false;
      const firstFetchDeferred = createDeferred<void>();
      const fetchFn = vi
        .fn()
        .mockImplementation(async ({ isInvalidated }: { isInvalidated: () => boolean }) => {
          if (fetchFn.mock.calls.length === 1) {
            await firstFetchDeferred.promise;
            firstInvalidatedAfter = isInvalidated();
          }
        });

      setupHook({ fetchFn });

      await waitFor(() => {
        expect(fetchFn).toHaveBeenCalledTimes(1);
      });

      // Force a sidebar refresh — queues a new fetch and invalidates the
      // in-flight one.
      await act(async () => {
        window.dispatchEvent(new CustomEvent("daintree:refresh-sidebar"));
        await Promise.resolve();
      });

      await act(async () => {
        firstFetchDeferred.resolve();
        await Promise.resolve();
      });

      expect(firstInvalidatedAfter).toBe(true);
    });
  });

  describe("control object", () => {
    it("returns a stable scheduleNextPoll / refresh control across renders", () => {
      const { hook } = setupHook({});
      const firstControl = hook.result.current;
      hook.rerender();
      expect(hook.result.current).toBe(firstControl);
      expect(hook.result.current.scheduleNextPoll).toBe(firstControl.scheduleNextPoll);
      expect(hook.result.current.refresh).toBe(firstControl.refresh);
    });

    it("refresh(force) threads the force flag through to fetchFn", async () => {
      const fetchFn = vi.fn().mockResolvedValue(undefined);
      const { hook } = setupHook({ fetchFn });

      await waitFor(() => {
        expect(fetchFn).toHaveBeenCalledTimes(1);
      });

      await act(async () => {
        await hook.result.current.refresh({ force: true });
      });

      expect(fetchFn).toHaveBeenCalledTimes(2);
      expect(fetchFn.mock.calls[1]?.[0]?.force).toBe(true);
    });
  });

  describe("resilience", () => {
    it("survives a fetchFn rejection and still schedules the next poll", async () => {
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const fetchFn = vi.fn().mockRejectedValue(new Error("transient failure"));
      const calculateNextInterval = vi.fn().mockReturnValue(30_000);

      setupHook({ fetchFn, calculateNextInterval });

      // calculateNextInterval is only called from inside scheduleNextPoll —
      // if the rejection had killed the lifecycle, this would never fire.
      await waitFor(() => {
        expect(fetchFn).toHaveBeenCalledTimes(1);
        expect(calculateNextInterval).toHaveBeenCalled();
      });

      consoleErrorSpy.mockRestore();
    });

    it("keeps refresh() functional after a previous fetchFn rejection", async () => {
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      let shouldReject = true;
      const fetchFn = vi.fn().mockImplementation(async () => {
        if (shouldReject) throw new Error("transient");
      });

      const { hook } = setupHook({ fetchFn });

      await waitFor(() => {
        expect(fetchFn).toHaveBeenCalledTimes(1);
      });

      shouldReject = false;
      await act(async () => {
        await hook.result.current.refresh({ force: true });
      });

      // The rejection cleared inFlightRef via the finally block, so a
      // subsequent refresh proceeds normally.
      expect(fetchFn).toHaveBeenCalledTimes(2);
      expect(fetchFn.mock.calls[1]?.[0]?.force).toBe(true);

      consoleErrorSpy.mockRestore();
    });
  });

  describe("cleanup safety", () => {
    it("does not call onProjectSwitch after unmount", async () => {
      let captured: (() => void) | undefined;
      onSwitchMock.mockImplementation((cb) => {
        captured = cb;
        return () => {};
      });

      const onProjectSwitch = vi.fn();
      const { hook } = setupHook({ onProjectSwitch });

      await waitFor(() => {
        expect(captured).toBeDefined();
      });

      hook.unmount();

      // After unmount, the singleton listener is torn down (last subscriber).
      // Even if a stray switch fires from the captured callback reference,
      // the empty subscriber Set means no fan-out targets exist.
      act(() => {
        captured?.();
      });

      expect(onProjectSwitch).not.toHaveBeenCalled();
    });
  });
});
