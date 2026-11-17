// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { act, renderHook } from "@testing-library/react";
import { useNotificationSnoozeExpiry } from "../useNotificationSnoozeExpiry";
import { useNotificationHistoryStore } from "@/store/slices/notificationHistorySlice";

const { getState } = useNotificationHistoryStore;
const START = new Date(2026, 0, 5, 9, 0).getTime();
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

function addUnread(correlationId: string) {
  getState().addEntry({ type: "info", message: `Thread ${correlationId}`, correlationId });
}

function stubWakeIpc() {
  const listeners: Array<(sleepDurationMs: number) => void> = [];
  const off = vi.fn();
  Reflect.set(window, "electron", {
    systemSleep: {
      onWake: (callback: (sleepDurationMs: number) => void) => {
        listeners.push(callback);
        return off;
      },
    },
  });
  return { wake: (ms: number) => listeners.forEach((cb) => cb(ms)), off };
}

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("useNotificationSnoozeExpiry", () => {
  beforeEach(() => {
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
    Reflect.deleteProperty(document, "visibilityState");
    Reflect.deleteProperty(window, "electron");
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("relights the unread count when a snooze set with the inbox closed ends", () => {
    renderHook(() => useNotificationSnoozeExpiry());
    addUnread("thread-a");
    act(() => getState().snoozeThread("thread-a", START + 10 * MINUTE));
    expect(getState().unreadCount).toBe(0);

    act(() => vi.advanceTimersByTime(10 * MINUTE - 1));
    expect(getState().unreadCount).toBe(0);

    act(() => vi.advanceTimersByTime(1));
    expect(getState().snoozedThreads).toEqual({});
    expect(getState().unreadCount).toBe(1);
  });

  it("arms for a snooze that was already in the store when it mounted", () => {
    addUnread("thread-a");
    getState().snoozeThread("thread-a", START + 5 * MINUTE);
    renderHook(() => useNotificationSnoozeExpiry());

    act(() => vi.advanceTimersByTime(5 * MINUTE));
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

  it("wakes each thread at its own expiry and re-arms for a nearer one", () => {
    renderHook(() => useNotificationSnoozeExpiry());
    addUnread("later");
    addUnread("sooner");
    act(() => getState().snoozeThread("later", START + 30 * MINUTE));
    act(() => getState().snoozeThread("sooner", START + 10 * MINUTE));
    expect(getState().unreadCount).toBe(0);

    act(() => vi.advanceTimersByTime(10 * MINUTE));
    expect(getState().snoozedThreads).toEqual({ later: START + 30 * MINUTE });
    expect(getState().unreadCount).toBe(1);

    act(() => vi.advanceTimersByTime(20 * MINUTE));
    expect(getState().snoozedThreads).toEqual({});
    expect(getState().unreadCount).toBe(2);
  });

  it("drops the timer when the only snooze is cleared early", () => {
    renderHook(() => useNotificationSnoozeExpiry());
    addUnread("thread-a");
    act(() => getState().snoozeThread("thread-a", START + 10 * MINUTE));
    act(() => getState().clearSnooze("thread-a"));
    // Let the inbox's debounced persist write run, so only a leaked expiry
    // timer would still be pending.
    act(() => vi.advanceTimersByTime(1000));

    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits out a snooze past the timer cap in chunks", () => {
    renderHook(() => useNotificationSnoozeExpiry());
    addUnread("thread-a");
    act(() => getState().snoozeThread("thread-a", START + 30 * DAY));

    act(() => vi.advanceTimersByTime(2_147_483_647));
    expect(getState().unreadCount).toBe(0);

    act(() => vi.advanceTimersByTime(30 * DAY - 2_147_483_647));
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
    act(() => window.dispatchEvent(new Event("focus")));
    expect(getState().unreadCount).toBe(1);
  });

  it("catches up when the machine wakes while the window stays visible and focused", () => {
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

  it("keeps a single scheduler through StrictMode's remount", () => {
    renderHook(() => useNotificationSnoozeExpiry(), { wrapper: StrictMode });
    addUnread("thread-a");
    act(() => getState().snoozeThread("thread-a", START + 10 * MINUTE));
    act(() => vi.advanceTimersByTime(1000));
    expect(vi.getTimerCount()).toBe(1);

    act(() => vi.advanceTimersByTime(10 * MINUTE));
    expect(getState().unreadCount).toBe(1);
  });

  it("stops the timer and its listeners on unmount", () => {
    const ipc = stubWakeIpc();
    const { unmount } = renderHook(() => useNotificationSnoozeExpiry());
    addUnread("thread-a");
    act(() => getState().snoozeThread("thread-a", START + 10 * MINUTE));
    unmount();
    expect(ipc.off).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(1000));
    expect(vi.getTimerCount()).toBe(0);

    vi.setSystemTime(START + 60 * MINUTE);
    act(() => {
      window.dispatchEvent(new Event("focus"));
      setVisibility("visible");
    });
    expect(getState().snoozedThreads).toEqual({ "thread-a": START + 10 * MINUTE });
    expect(getState().unreadCount).toBe(0);
  });
});
