// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { act, renderHook } from "@testing-library/react";
import { useNotificationSnoozeExpiry } from "../useNotificationSnoozeExpiry";
import {
  flushNotificationHistory,
  useNotificationHistoryStore,
} from "@/store/slices/notificationHistorySlice";

const { getState } = useNotificationHistoryStore;
const START = new Date(2026, 0, 5, 9, 0).getTime();
const MINUTE = 60_000;
const MAX_TIMEOUT_MS = 2_147_483_647;

function addUnread(correlationId: string) {
  getState().addEntry({ type: "info", message: `Thread ${correlationId}`, correlationId });
}

function stubWakeIpc() {
  const listeners = new Set<(sleepDurationMs: number) => void>();
  const off = vi.fn();
  Reflect.set(window, "electron", {
    systemSleep: {
      onWake: (callback: (sleepDurationMs: number) => void) => {
        listeners.add(callback);
        return () => {
          off();
          listeners.delete(callback);
        };
      },
    },
  });
  return { wake: (ms: number) => listeners.forEach((cb) => cb(ms)), off };
}

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

// The store's own persist write is debounced on a timer, so let it run first
// and count what is left: only the snooze scheduler's timers.
function pendingSchedulerTimers(): number {
  act(() => {
    vi.advanceTimersByTime(1000);
  });
  return vi.getTimerCount();
}

describe("useNotificationSnoozeExpiry", () => {
  let visibilityDescriptor: PropertyDescriptor | undefined;
  let electronDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    visibilityDescriptor = Object.getOwnPropertyDescriptor(document, "visibilityState");
    electronDescriptor = Object.getOwnPropertyDescriptor(window, "electron");
    vi.useFakeTimers();
    vi.setSystemTime(START);
    useNotificationHistoryStore.setState({
      entries: [],
      unreadCount: 0,
      evictedToInboxCount: 0,
      snoozedThreads: {},
    });
  });

  afterEach(() => {
    flushNotificationHistory();
    // Before the real clock comes back, or restoring the setTimeout spy would
    // reinstall the fake it wrapped.
    vi.restoreAllMocks();
    vi.useRealTimers();
    if (visibilityDescriptor) {
      Object.defineProperty(document, "visibilityState", visibilityDescriptor);
    } else {
      Reflect.deleteProperty(document, "visibilityState");
    }
    if (electronDescriptor) {
      Object.defineProperty(window, "electron", electronDescriptor);
    } else {
      Reflect.deleteProperty(window, "electron");
    }
  });

  it("relights the unread count when a snooze set with the inbox closed ends", () => {
    renderHook(() => useNotificationSnoozeExpiry());
    addUnread("thread-a");
    act(() => getState().snoozeThread("thread-a", START + 10 * MINUTE));
    expect(getState().unreadCount).toBe(0);

    act(() => {
      vi.advanceTimersByTime(10 * MINUTE - 1);
    });
    expect(getState().unreadCount).toBe(0);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(getState().snoozedThreads).toEqual({});
    expect(getState().unreadCount).toBe(1);
  });

  it("arms for a snooze that was already in the store when it mounted", () => {
    addUnread("thread-a");
    getState().snoozeThread("thread-a", START + 5 * MINUTE);
    renderHook(() => useNotificationSnoozeExpiry());

    act(() => {
      vi.advanceTimersByTime(5 * MINUTE);
    });
    expect(getState().unreadCount).toBe(1);
  });

  it("clears a snooze that ended before it mounted at once", () => {
    addUnread("thread-a");
    getState().snoozeThread("thread-a", START + MINUTE);
    vi.setSystemTime(START + 2 * MINUTE);

    renderHook(() => useNotificationSnoozeExpiry());
    expect(getState().snoozedThreads).toEqual({});
    expect(getState().unreadCount).toBe(1);
  });

  it("defers the sweep for an already-ended snooze written while mounted", () => {
    renderHook(() => useNotificationSnoozeExpiry());
    addUnread("thread-a");

    // The store's change notification only schedules: sweeping inside it would
    // nest a second store write.
    act(() => getState().snoozeThread("thread-a", START - MINUTE));
    expect(getState().snoozedThreads).toEqual({ "thread-a": START - MINUTE });

    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(getState().snoozedThreads).toEqual({});
    expect(getState().unreadCount).toBe(1);
  });

  it("wakes each thread at its own expiry and re-arms for a nearer one", () => {
    renderHook(() => useNotificationSnoozeExpiry());
    addUnread("later");
    addUnread("sooner");
    act(() => getState().snoozeThread("later", START + 30 * MINUTE));
    act(() => getState().snoozeThread("sooner", START + 10 * MINUTE));
    expect(getState().unreadCount).toBe(0);

    act(() => {
      vi.advanceTimersByTime(10 * MINUTE);
    });
    expect(getState().snoozedThreads).toEqual({ later: START + 30 * MINUTE });
    expect(getState().unreadCount).toBe(1);

    act(() => {
      vi.advanceTimersByTime(20 * MINUTE);
    });
    expect(getState().snoozedThreads).toEqual({});
    expect(getState().unreadCount).toBe(2);
  });

  it("keeps one timer on the nearest expiry when the nearer snooze was taken first", () => {
    renderHook(() => useNotificationSnoozeExpiry());
    addUnread("sooner");
    addUnread("later");
    act(() => getState().snoozeThread("sooner", START + 10 * MINUTE));
    act(() => getState().snoozeThread("later", START + 30 * MINUTE));
    expect(pendingSchedulerTimers()).toBe(1);

    act(() => {
      vi.advanceTimersByTime(10 * MINUTE - 1000);
    });
    expect(getState().snoozedThreads).toEqual({ later: START + 30 * MINUTE });
    expect(getState().unreadCount).toBe(1);
  });

  it("drops the timer when the only snooze is cleared early", () => {
    renderHook(() => useNotificationSnoozeExpiry());
    addUnread("thread-a");
    act(() => getState().snoozeThread("thread-a", START + 10 * MINUTE));
    act(() => getState().clearSnooze("thread-a"));

    expect(pendingSchedulerTimers()).toBe(0);
  });

  it("waits out a snooze past the timer cap in capped chunks", () => {
    renderHook(() => useNotificationSnoozeExpiry());
    addUnread("thread-a");
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    act(() => getState().snoozeThread("thread-a", START + MAX_TIMEOUT_MS + 2));
    expect(setTimeoutSpy.mock.calls.map(([, delay]) => delay)).toContain(MAX_TIMEOUT_MS);

    act(() => {
      vi.advanceTimersByTime(MAX_TIMEOUT_MS);
    });
    expect(getState().unreadCount).toBe(0);

    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(getState().unreadCount).toBe(1);
  });

  it("catches up when the window becomes visible after the clock moved past expiry", () => {
    renderHook(() => useNotificationSnoozeExpiry());
    addUnread("thread-a");
    act(() => getState().snoozeThread("thread-a", START + 10 * MINUTE));

    // A sleeping machine moves the wall clock without running the timer.
    vi.setSystemTime(START + 60 * MINUTE);
    act(() => setVisibility("hidden"));
    expect(getState().unreadCount).toBe(0);

    act(() => setVisibility("visible"));
    expect(getState().snoozedThreads).toEqual({});
    expect(getState().unreadCount).toBe(1);
  });

  it("catches up when the window regains focus after the clock moved past expiry", () => {
    renderHook(() => useNotificationSnoozeExpiry());
    addUnread("thread-a");
    act(() => getState().snoozeThread("thread-a", START + 10 * MINUTE));

    vi.setSystemTime(START + 60 * MINUTE);
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(getState().unreadCount).toBe(1);
  });

  it("catches up on a system wake with no window event", () => {
    const ipc = stubWakeIpc();
    renderHook(() => useNotificationSnoozeExpiry());
    addUnread("thread-a");
    act(() => getState().snoozeThread("thread-a", START + 10 * MINUTE));

    vi.setSystemTime(START + 60 * MINUTE);
    expect(getState().unreadCount).toBe(0);
    act(() => ipc.wake(60 * MINUTE));
    expect(getState().snoozedThreads).toEqual({});
    expect(getState().unreadCount).toBe(1);
  });

  it("re-arms on a wake before expiry so the thread wakes at its own deadline", () => {
    const ipc = stubWakeIpc();
    renderHook(() => useNotificationSnoozeExpiry());
    addUnread("thread-a");
    act(() => getState().snoozeThread("thread-a", START + 10 * MINUTE));

    // Six minutes pass on the wall clock while the timer stands still.
    vi.setSystemTime(START + 6 * MINUTE);
    act(() => ipc.wake(6 * MINUTE));
    expect(getState().unreadCount).toBe(0);

    act(() => {
      vi.advanceTimersByTime(4 * MINUTE);
    });
    expect(getState().unreadCount).toBe(1);
  });

  it("keeps a single scheduler through StrictMode's remount", () => {
    addUnread("thread-a");
    getState().snoozeThread("thread-a", START + 10 * MINUTE);
    renderHook(() => useNotificationSnoozeExpiry(), { wrapper: StrictMode });
    expect(pendingSchedulerTimers()).toBe(1);

    act(() => {
      vi.advanceTimersByTime(10 * MINUTE);
    });
    expect(getState().unreadCount).toBe(1);
  });

  it("stops the timer and its listeners on unmount", () => {
    const ipc = stubWakeIpc();
    const { unmount } = renderHook(() => useNotificationSnoozeExpiry());
    addUnread("thread-a");
    addUnread("thread-b");
    act(() => getState().snoozeThread("thread-a", START + 10 * MINUTE));
    unmount();
    expect(ipc.off).toHaveBeenCalledTimes(1);
    expect(pendingSchedulerTimers()).toBe(0);

    act(() => getState().snoozeThread("thread-b", START + 20 * MINUTE));
    act(() => {
      vi.advanceTimersByTime(30 * MINUTE);
    });
    act(() => {
      window.dispatchEvent(new Event("focus"));
      setVisibility("visible");
      ipc.wake(30 * MINUTE);
    });
    expect(getState().snoozedThreads).toEqual({
      "thread-a": START + 10 * MINUTE,
      "thread-b": START + 20 * MINUTE,
    });
    expect(getState().unreadCount).toBe(0);
  });
});
