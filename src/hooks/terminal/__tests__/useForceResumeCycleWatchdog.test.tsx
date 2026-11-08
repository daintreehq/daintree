// @vitest-environment jsdom
import { renderHook, act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import type { TerminalReliabilityMetricPayload } from "@shared/types/pty-host";

const notifyMock = vi.fn((_payload: unknown) => "notice-1");
vi.mock("@/lib/notify", () => ({
  notify: (payload: unknown) => notifyMock(payload),
}));

vi.mock("@/store/projectStore", () => ({
  useProjectStore: { getState: () => ({ currentProject: { id: "p1" } }) },
}));

type ResyncOptions = { settlePendingWrites?: boolean; signal?: AbortSignal };
const fetchAndRestoreMock = vi.fn((_id: string, _options?: ResyncOptions): Promise<boolean> =>
  Promise.resolve(true)
);
const resetRendererMock = vi.fn((_id: string, _options?: { force?: boolean }) => true);
let serviceLoaded = true;
vi.mock("@/services/terminal/terminalInstanceServiceAccessor", () => ({
  peek: () =>
    serviceLoaded
      ? {
          fetchAndRestore: (id: string, options?: ResyncOptions) =>
            fetchAndRestoreMock(id, options),
          resetRenderer: (id: string, options?: { force?: boolean }) =>
            resetRendererMock(id, options),
        }
      : null,
}));

// Registry of bus subscribers keyed by event name, so tests can drive metrics.
type MetricListener = (payload: TerminalReliabilityMetricPayload) => void;
let listeners: Map<string, Set<MetricListener>>;
const unsubSpy = vi.fn();

const eventsOn = vi.fn((name: string, cb: MetricListener) => {
  let set = listeners.get(name);
  if (!set) {
    set = new Set();
    listeners.set(name, set);
  }
  set.add(cb);
  return () => {
    set?.delete(cb);
    unsubSpy();
  };
});

// Main's view-lifecycle broadcasts, as preload exposes them. A cached
// WebContentsView keeps reporting `document.visibilityState === "visible"`, so
// these are the only signal that the view went away.
let viewCached = false;
const viewCachedListeners = new Set<() => void>();
const viewActivatedListeners = new Set<() => void>();
function subscribe(set: Set<() => void>) {
  return (cb: () => void) => {
    set.add(cb);
    return () => {
      set.delete(cb);
    };
  };
}

vi.stubGlobal("window", {
  ...globalThis.window,
  electron: {
    events: { on: eventsOn },
    app: {
      isViewCached: () => viewCached,
      onViewCached: subscribe(viewCachedListeners),
      onViewWarmActivated: subscribe(viewActivatedListeners),
      onViewRevealed: subscribe(new Set()),
    },
  },
});

import {
  useForceResumeCycleWatchdog,
  __resetAutomaticResyncQueueForTests,
} from "../useForceResumeCycleWatchdog";
import { __resetTerminalStallNoticeForTests } from "../terminalStallNotice";
import { __resetProjectViewCacheStateForTests } from "@/lib/viewCacheState";

const RESYNC_OPTIONS = { settlePendingWrites: true, signal: expect.any(AbortSignal) };

function emitMetric(payload: Partial<TerminalReliabilityMetricPayload>): void {
  const full: TerminalReliabilityMetricPayload = {
    terminalId: "t1",
    metricType: "pause-end",
    timestamp: Date.now(),
    ...payload,
  };
  act(() => {
    for (const cb of listeners.get("terminal:reliability-metric") ?? []) {
      cb(full);
    }
  });
}

/** A pause the host held for its full 10s safety window, ending now. */
function forceResume(terminalId = "t1"): void {
  act(() => {
    vi.advanceTimersByTime(10_000);
  });
  emitMetric({ terminalId, durationMs: 9950 });
}

/** A pause that ended within the watermark, i.e. the renderer drained on its own. */
function naturalDrain(terminalId = "t1"): void {
  act(() => {
    vi.advanceTimersByTime(200);
  });
  emitMetric({ terminalId, durationMs: 120 });
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 50; i++) await Promise.resolve();
  });
}

/** Three force-resumes, then let the automatic resync they trigger settle. */
async function stallUntilResync(terminalId = "t1"): Promise<void> {
  forceResume(terminalId);
  forceResume(terminalId);
  forceResume(terminalId);
  await settle();
}

function cacheView(): void {
  act(() => {
    viewCached = true;
    for (const cb of [...viewCachedListeners]) cb();
  });
}

function activateView(): void {
  act(() => {
    viewCached = false;
    for (const cb of [...viewActivatedListeners]) cb();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  listeners = new Map();
  viewCached = false;
  serviceLoaded = true;
  notifyMock.mockClear();
  fetchAndRestoreMock.mockReset();
  fetchAndRestoreMock.mockImplementation(() => Promise.resolve(true));
  resetRendererMock.mockClear();
  unsubSpy.mockClear();
  eventsOn.mockClear();
  __resetProjectViewCacheStateForTests();
  __resetTerminalStallNoticeForTests();
  __resetAutomaticResyncQueueForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useForceResumeCycleWatchdog", () => {
  describe("automatic recovery", () => {
    it("resyncs from the host after three force-resumes without showing anything", async () => {
      const { result } = renderHook(() => useForceResumeCycleWatchdog("t1"));

      forceResume();
      forceResume();
      await settle();
      expect(fetchAndRestoreMock).not.toHaveBeenCalled();
      forceResume();
      await settle();

      expect(fetchAndRestoreMock).toHaveBeenCalledTimes(1);
      expect(fetchAndRestoreMock).toHaveBeenCalledWith("t1", RESYNC_OPTIONS);
      // The automatic path leaves the forced renderer repair to the manual one.
      expect(resetRendererMock).not.toHaveBeenCalled();
      expect(result.current.showBanner).toBe(false);
      expect(notifyMock).not.toHaveBeenCalled();
    });

    it("clears the stall without a click when the resync works", async () => {
      const { result } = renderHook(() => useForceResumeCycleWatchdog("t1"));

      await stallUntilResync();
      expect(fetchAndRestoreMock).toHaveBeenCalledTimes(1);
      // Two more force-resumes are short of a new streak, and the output then
      // drains on its own: nothing was ever shown.
      forceResume();
      forceResume();
      naturalDrain();
      forceResume();
      forceResume();
      await settle();

      expect(result.current.showBanner).toBe(false);
      expect(notifyMock).not.toHaveBeenCalled();
    });

    it("re-arms automatic recovery after a natural drain", async () => {
      renderHook(() => useForceResumeCycleWatchdog("t1"));

      await stallUntilResync();
      naturalDrain();
      await stallUntilResync();

      expect(fetchAndRestoreMock).toHaveBeenCalledTimes(2);
    });

    it("counts only force-resumes whose pause began after the resync", async () => {
      let finishResync!: (ok: boolean) => void;
      fetchAndRestoreMock.mockImplementationOnce(
        () => new Promise<boolean>((resolve) => (finishResync = resolve))
      );
      const { result } = renderHook(() => useForceResumeCycleWatchdog("t1"));

      await stallUntilResync();
      // Force-resumes during the resync don't count toward anything. Each is
      // a few seconds apart so the resync stays inside its 15s bound.
      for (let i = 0; i < 3; i++) {
        act(() => {
          vi.advanceTimersByTime(4000);
        });
        emitMetric({ durationMs: 9950 });
      }
      await act(async () => finishResync(true));
      await settle();
      expect(result.current.showBanner).toBe(false);

      // A pause ending 2s after the resync began well before it.
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      emitMetric({ durationMs: 9950 });
      forceResume();
      forceResume();
      expect(result.current.showBanner).toBe(false);
      forceResume();
      expect(result.current.showBanner).toBe(true);
    });

    it("runs one automatic resync at a time across terminals", async () => {
      const finishers: Array<(ok: boolean) => void> = [];
      fetchAndRestoreMock.mockImplementation(
        () => new Promise<boolean>((resolve) => finishers.push(resolve))
      );
      renderHook(() => useForceResumeCycleWatchdog("t1"));
      renderHook(() => useForceResumeCycleWatchdog("t2"));

      for (let i = 0; i < 3; i++) {
        forceResume("t1");
        emitMetric({ terminalId: "t2", durationMs: 9950 });
      }
      await settle();
      expect(fetchAndRestoreMock.mock.calls.map(([id]) => id)).toEqual(["t1"]);

      await act(async () => finishers[0]!(true));
      await settle();
      expect(fetchAndRestoreMock.mock.calls.map(([id]) => id)).toEqual(["t1", "t2"]);
      await act(async () => finishers[1]!(true));
    });

    it("drops a queued resync whose terminal drained while it waited", async () => {
      let finishFirst!: (ok: boolean) => void;
      fetchAndRestoreMock.mockImplementationOnce(
        () => new Promise<boolean>((resolve) => (finishFirst = resolve))
      );
      renderHook(() => useForceResumeCycleWatchdog("t1"));
      renderHook(() => useForceResumeCycleWatchdog("t2"));

      for (let i = 0; i < 3; i++) {
        forceResume("t1");
        emitMetric({ terminalId: "t2", durationMs: 9950 });
      }
      await settle();
      emitMetric({ terminalId: "t2", durationMs: 120 });
      await act(async () => finishFirst(true));
      await settle();

      expect(fetchAndRestoreMock.mock.calls.map(([id]) => id)).toEqual(["t1"]);
    });

    it.each([
      ["fails", () => Promise.resolve(false)],
      ["never settles", () => new Promise<boolean>(() => {})],
    ])("moves on to the next queued resync when one %s", async (_label, first) => {
      fetchAndRestoreMock.mockImplementationOnce(first);
      renderHook(() => useForceResumeCycleWatchdog("t1"));
      renderHook(() => useForceResumeCycleWatchdog("t2"));

      for (let i = 0; i < 3; i++) {
        forceResume("t1");
        emitMetric({ terminalId: "t2", durationMs: 9950 });
      }
      await settle();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });

      expect(fetchAndRestoreMock.mock.calls.map(([id]) => id)).toEqual(["t1", "t2"]);
    });

    it("ignores a resync that settles after a natural drain reset the episode", async () => {
      let finishResync!: (ok: boolean) => void;
      fetchAndRestoreMock.mockImplementationOnce(
        () => new Promise<boolean>((resolve) => (finishResync = resolve))
      );
      const { result } = renderHook(() => useForceResumeCycleWatchdog("t1"));

      await stallUntilResync();
      naturalDrain();
      await act(async () => finishResync(false));
      await settle();

      expect(result.current.showBanner).toBe(false);
      expect(notifyMock).not.toHaveBeenCalled();
    });

    it("doesn't spend automatic recovery on a success that arrives after a drain", async () => {
      let finishResync!: (ok: boolean) => void;
      fetchAndRestoreMock.mockImplementationOnce(
        () => new Promise<boolean>((resolve) => (finishResync = resolve))
      );
      const { result } = renderHook(() => useForceResumeCycleWatchdog("t1"));

      await stallUntilResync();
      naturalDrain();
      await act(async () => finishResync(true));
      await stallUntilResync();

      // A fresh episode resyncs again rather than escalating straight away.
      expect(fetchAndRestoreMock).toHaveBeenCalledTimes(2);
      expect(result.current.showBanner).toBe(false);
    });

    it("aborts a resync that outlives its deadline so a late snapshot isn't applied", async () => {
      fetchAndRestoreMock.mockImplementationOnce(() => new Promise<boolean>(() => {}));
      renderHook(() => useForceResumeCycleWatchdog("t1"));

      await stallUntilResync();
      const signal = fetchAndRestoreMock.mock.calls[0]![1]!.signal!;
      expect(signal.aborted).toBe(false);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });
      expect(signal.aborted).toBe(true);
    });

    it("leaves nothing behind when the pane unmounts mid-resync", async () => {
      let finishResync!: (ok: boolean) => void;
      fetchAndRestoreMock.mockImplementationOnce(
        () => new Promise<boolean>((resolve) => (finishResync = resolve))
      );
      const { unmount } = renderHook(() => useForceResumeCycleWatchdog("t1"));

      await stallUntilResync();
      unmount();
      await act(async () => finishResync(false));
      await settle();

      expect(notifyMock).not.toHaveBeenCalled();
    });
  });

  describe("escalation", () => {
    it("escalates when the automatic resync fails", async () => {
      fetchAndRestoreMock.mockResolvedValueOnce(false);
      const { result } = renderHook(() => useForceResumeCycleWatchdog("t1"));

      await stallUntilResync();

      expect(result.current.showBanner).toBe(true);
      expect(notifyMock).toHaveBeenCalledTimes(1);
      expect(notifyMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: "warning", placement: "grid-bar" })
      );
    });

    it.each([
      ["rejects", () => Promise.reject(new Error("host gone"))],
      [
        "throws",
        () => {
          throw new Error("service torn down");
        },
      ],
    ])("escalates when the resync %s", async (_label, failure) => {
      fetchAndRestoreMock.mockImplementationOnce(failure);
      const { result } = renderHook(() => useForceResumeCycleWatchdog("t1"));

      await stallUntilResync();

      expect(result.current.showBanner).toBe(true);
    });

    it("escalates when the resync never settles", async () => {
      fetchAndRestoreMock.mockImplementationOnce(() => new Promise<boolean>(() => {}));
      const { result } = renderHook(() => useForceResumeCycleWatchdog("t1"));

      await stallUntilResync();
      expect(result.current.showBanner).toBe(false);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });
      expect(result.current.showBanner).toBe(true);
    });

    it("escalates when the terminal service isn't loaded to resync", async () => {
      serviceLoaded = false;
      const { result } = renderHook(() => useForceResumeCycleWatchdog("t1"));

      await stallUntilResync();

      expect(result.current.showBanner).toBe(true);
    });

    it("escalates when output stalls three more times after a successful resync", async () => {
      const { result } = renderHook(() => useForceResumeCycleWatchdog("t1"));

      await stallUntilResync();
      forceResume();
      forceResume();
      expect(result.current.showBanner).toBe(false);
      forceResume();
      await settle();

      expect(result.current.showBanner).toBe(true);
      expect(notifyMock).toHaveBeenCalledTimes(1);
      // The automatic resync is spent; it isn't simply repeated.
      expect(fetchAndRestoreMock).toHaveBeenCalledTimes(1);
    });

    it("treats the threshold as inclusive (>= 9900) and 9899 as a natural drain", async () => {
      renderHook(() => useForceResumeCycleWatchdog("t1"));

      for (let i = 0; i < 3; i++) {
        act(() => {
          vi.advanceTimersByTime(10_000);
        });
        emitMetric({ durationMs: 9899 });
      }
      await settle();
      expect(fetchAndRestoreMock).not.toHaveBeenCalled();

      for (let i = 0; i < 3; i++) {
        act(() => {
          vi.advanceTimersByTime(10_000);
        });
        emitMetric({ durationMs: 9900 });
      }
      await settle();
      expect(fetchAndRestoreMock).toHaveBeenCalledTimes(1);
    });

    it("treats 9899 mid-streak as a drain that resets it", async () => {
      renderHook(() => useForceResumeCycleWatchdog("t1"));

      forceResume();
      forceResume();
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      emitMetric({ durationMs: 9899 });
      forceResume();
      forceResume();
      await settle();
      expect(fetchAndRestoreMock).not.toHaveBeenCalled();

      forceResume();
      await settle();
      expect(fetchAndRestoreMock).toHaveBeenCalledTimes(1);
    });

    it("resets the streak on a confirmed natural drain", async () => {
      renderHook(() => useForceResumeCycleWatchdog("t1"));

      forceResume();
      forceResume();
      naturalDrain();
      forceResume();
      forceResume();
      await settle();
      expect(fetchAndRestoreMock).not.toHaveBeenCalled();

      forceResume();
      await settle();
      expect(fetchAndRestoreMock).toHaveBeenCalledTimes(1);
    });

    it("hides the banner on a drain after escalation and treats the next stall as new", async () => {
      fetchAndRestoreMock.mockResolvedValue(false);
      const { result } = renderHook(() => useForceResumeCycleWatchdog("t1"));

      await stallUntilResync();
      expect(result.current.showBanner).toBe(true);

      naturalDrain();
      expect(result.current.showBanner).toBe(false);

      // A fresh stall is a fresh incident: it tries recovery and posts again.
      await stallUntilResync();
      expect(fetchAndRestoreMock).toHaveBeenCalledTimes(2);
      expect(result.current.showBanner).toBe(true);
      expect(notifyMock).toHaveBeenCalledTimes(2);
    });

    it.each([undefined, NaN, Infinity, -Infinity])(
      "neither counts nor resets on an ambiguous durationMs (%s)",
      async (durationMs) => {
        renderHook(() => useForceResumeCycleWatchdog("t1"));

        forceResume();
        forceResume();
        emitMetric({ durationMs });
        await settle();
        expect(fetchAndRestoreMock).not.toHaveBeenCalled();

        forceResume();
        await settle();
        expect(fetchAndRestoreMock).toHaveBeenCalledTimes(1);
      }
    );

    it("ignores metrics for other terminals and non-pause-end types", async () => {
      renderHook(() => useForceResumeCycleWatchdog("t1"));

      forceResume();
      forceResume();
      // Unrelated terminal force-resumes between cycles 2 and 3 — must be inert.
      emitMetric({ terminalId: "other", durationMs: 9950 });
      emitMetric({ metricType: "suspend", durationMs: 120 });
      await settle();
      expect(fetchAndRestoreMock).not.toHaveBeenCalled();

      forceResume();
      await settle();
      expect(fetchAndRestoreMock).toHaveBeenCalledWith("t1", RESYNC_OPTIONS);
    });
  });

  describe("hidden project views", () => {
    it("shows nothing after returning to a view whose stall happened while it was cached", async () => {
      const { result } = renderHook(() => useForceResumeCycleWatchdog("t1"));

      cacheView();
      for (let i = 0; i < 6; i++) forceResume();
      await settle();
      activateView();

      // The first pause to end after the switch back started while cached.
      act(() => {
        vi.advanceTimersByTime(1500);
      });
      emitMetric({ durationMs: 9950 });
      naturalDrain();
      await settle();

      expect(result.current.showBanner).toBe(false);
      expect(fetchAndRestoreMock).not.toHaveBeenCalled();
      expect(notifyMock).not.toHaveBeenCalled();
    });

    it("doesn't count a pause that began while the view was cached", async () => {
      renderHook(() => useForceResumeCycleWatchdog("t1"));

      cacheView();
      act(() => {
        vi.advanceTimersByTime(30_000);
      });
      activateView();
      // Ends 1.5s after the switch back, so it began while the view was cached.
      act(() => {
        vi.advanceTimersByTime(1500);
      });
      emitMetric({ durationMs: 9950 });
      forceResume();
      forceResume();
      await settle();
      expect(fetchAndRestoreMock).not.toHaveBeenCalled();

      forceResume();
      await settle();
      expect(fetchAndRestoreMock).toHaveBeenCalledTimes(1);
    });

    it("doesn't count pauses that began before the pane mounted", async () => {
      renderHook(() => useForceResumeCycleWatchdog("t1"));

      for (let i = 0; i < 3; i++) {
        act(() => {
          vi.advanceTimersByTime(100);
        });
        emitMetric({ durationMs: 9950 });
      }
      await settle();

      expect(fetchAndRestoreMock).not.toHaveBeenCalled();
    });

    it("drops a streak built before the view was cached", async () => {
      renderHook(() => useForceResumeCycleWatchdog("t1"));

      forceResume();
      forceResume();
      cacheView();
      activateView();
      forceResume();
      forceResume();
      await settle();
      expect(fetchAndRestoreMock).not.toHaveBeenCalled();

      forceResume();
      await settle();
      expect(fetchAndRestoreMock).toHaveBeenCalledTimes(1);
    });

    it("clears an escalated banner when the view is cached", async () => {
      fetchAndRestoreMock.mockResolvedValueOnce(false);
      const { result } = renderHook(() => useForceResumeCycleWatchdog("t1"));

      await stallUntilResync();
      expect(result.current.showBanner).toBe(true);

      cacheView();
      expect(result.current.showBanner).toBe(false);
      activateView();
      expect(result.current.showBanner).toBe(false);

      // The terminal left the incident with its banner, so a new stall posts again.
      fetchAndRestoreMock.mockResolvedValueOnce(false);
      await stallUntilResync();
      expect(notifyMock).toHaveBeenCalledTimes(2);
    });

    it("ignores the result of a resync that settles after the view was cached", async () => {
      let finishResync!: (ok: boolean) => void;
      fetchAndRestoreMock.mockImplementationOnce(
        () => new Promise<boolean>((resolve) => (finishResync = resolve))
      );
      const { result } = renderHook(() => useForceResumeCycleWatchdog("t1"));

      await stallUntilResync();
      cacheView();
      await act(async () => finishResync(false));
      await settle();

      expect(result.current.showBanner).toBe(false);
      expect(notifyMock).not.toHaveBeenCalled();
    });
  });

  describe("retry", () => {
    async function escalate(result: { current: { showBanner: boolean } }) {
      fetchAndRestoreMock.mockResolvedValueOnce(false);
      await stallUntilResync();
      expect(result.current.showBanner).toBe(true);
    }

    it("forces a renderer repair and resyncs, clearing the banner when it works", async () => {
      const { result } = renderHook(() => useForceResumeCycleWatchdog("t1"));
      await escalate(result);
      fetchAndRestoreMock.mockClear();

      act(() => result.current.retry());
      expect(result.current.isRetrying).toBe(true);
      await settle();

      expect(resetRendererMock).toHaveBeenCalledWith("t1", { force: true });
      expect(fetchAndRestoreMock).toHaveBeenCalledWith("t1", RESYNC_OPTIONS);
      expect(result.current.showBanner).toBe(false);
      expect(result.current.isRetrying).toBe(false);

      // It also left the incident: the next escalation posts a fresh notice.
      await stallUntilResync();
      expect(result.current.showBanner).toBe(true);
      expect(notifyMock).toHaveBeenCalledTimes(2);
    });

    it("keeps the banner when the retry's resync fails", async () => {
      const { result } = renderHook(() => useForceResumeCycleWatchdog("t1"));
      await escalate(result);

      fetchAndRestoreMock.mockClear();
      fetchAndRestoreMock.mockResolvedValueOnce(false);
      act(() => result.current.retry());
      expect(result.current.isRetrying).toBe(true);
      await settle();

      expect(fetchAndRestoreMock).toHaveBeenCalledTimes(1);
      expect(result.current.showBanner).toBe(true);
      expect(result.current.isRetrying).toBe(false);

      // A failed attempt doesn't lock the button.
      act(() => result.current.retry());
      await settle();
      expect(fetchAndRestoreMock).toHaveBeenCalledTimes(2);
      expect(result.current.showBanner).toBe(false);
    });

    it("ignores a retry that succeeds after the view was cached", async () => {
      const { result } = renderHook(() => useForceResumeCycleWatchdog("t1"));
      await escalate(result);
      let finishRetry!: (ok: boolean) => void;
      fetchAndRestoreMock.mockImplementationOnce(
        () => new Promise<boolean>((resolve) => (finishRetry = resolve))
      );

      act(() => result.current.retry());
      cacheView();
      await act(async () => finishRetry(true));
      activateView();
      fetchAndRestoreMock.mockClear();
      await stallUntilResync();

      // The new episode still has its automatic resync: the late success
      // didn't mark it spent.
      expect(fetchAndRestoreMock).toHaveBeenCalledTimes(1);
      expect(result.current.showBanner).toBe(false);
    });

    it("escalates on the next streak after a successful retry", async () => {
      const { result } = renderHook(() => useForceResumeCycleWatchdog("t1"));
      await escalate(result);

      act(() => result.current.retry());
      await settle();
      expect(result.current.showBanner).toBe(false);
      fetchAndRestoreMock.mockClear();

      forceResume();
      forceResume();
      forceResume();
      await settle();

      expect(result.current.showBanner).toBe(true);
      expect(fetchAndRestoreMock).not.toHaveBeenCalled();
    });

    it("ignores a second press while one is running", async () => {
      const { result } = renderHook(() => useForceResumeCycleWatchdog("t1"));
      await escalate(result);
      fetchAndRestoreMock.mockClear();

      act(() => {
        result.current.retry();
        result.current.retry();
      });
      await settle();

      expect(fetchAndRestoreMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("aggregated notice", () => {
    it("posts one notice for four terminals that stall together", async () => {
      fetchAndRestoreMock.mockResolvedValue(false);
      const ids = ["t1", "t2", "t3", "t4"];
      const hooks = ids.map((id) => renderHook(() => useForceResumeCycleWatchdog(id)));

      for (let i = 0; i < 3; i++) {
        for (const id of ids) emitMetric({ terminalId: id, durationMs: 9950 });
        act(() => {
          vi.advanceTimersByTime(10_000);
        });
      }
      // The first round of pauses began at mount, before the watch did.
      for (const id of ids) emitMetric({ terminalId: id, durationMs: 9950 });
      await settle();

      for (const hook of hooks) expect(hook.result.current.showBanner).toBe(true);
      expect(notifyMock).toHaveBeenCalledTimes(1);
    });

    it("posts again for a new incident once the escalated pane has unmounted", async () => {
      fetchAndRestoreMock.mockResolvedValue(false);
      const { unmount } = renderHook(() => useForceResumeCycleWatchdog("t1"));
      await stallUntilResync();
      expect(notifyMock).toHaveBeenCalledTimes(1);
      unmount();

      renderHook(() => useForceResumeCycleWatchdog("t2"));
      await stallUntilResync("t2");
      expect(notifyMock).toHaveBeenCalledTimes(2);
    });
  });

  it("starts over when the terminal restarts under the same id", async () => {
    fetchAndRestoreMock.mockResolvedValueOnce(false);
    const { result, rerender } = renderHook(
      ({ restartKey }) => useForceResumeCycleWatchdog("t1", restartKey),
      { initialProps: { restartKey: 0 } }
    );

    await stallUntilResync();
    expect(result.current.showBanner).toBe(true);

    rerender({ restartKey: 1 });
    expect(result.current.showBanner).toBe(false);

    // The new process gets its own automatic resync, and its own notice.
    fetchAndRestoreMock.mockClear();
    fetchAndRestoreMock.mockResolvedValueOnce(false);
    await stallUntilResync();
    expect(fetchAndRestoreMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledTimes(2);
  });

  it("tears down the old subscription and resets state when the id changes", async () => {
    fetchAndRestoreMock.mockResolvedValue(false);
    const { result, rerender } = renderHook(({ id }) => useForceResumeCycleWatchdog(id), {
      initialProps: { id: "t1" },
    });

    await stallUntilResync();
    expect(result.current.showBanner).toBe(true);

    rerender({ id: "t2" });
    expect(unsubSpy).toHaveBeenCalled();
    expect(result.current.showBanner).toBe(false);
    expect(eventsOn).toHaveBeenLastCalledWith("terminal:reliability-metric", expect.any(Function));

    // Metrics for the old id are now inert; t2 needs its own streak.
    await stallUntilResync("t1");
    expect(result.current.showBanner).toBe(false);

    await stallUntilResync("t2");
    expect(result.current.showBanner).toBe(true);
  });
});
