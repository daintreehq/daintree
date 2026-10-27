// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import type { PowerPolicySnapshot } from "@shared/types/powerPolicy";
import {
  notify,
  _resetCoalesceMap,
  _resetRateLimitBuckets,
  _setQuietUntil,
  setActiveContextAccessors,
  _resetActiveContextAccessorsForTest,
  _resetPendingSuppressedForTest,
} from "../notify";
import { __resetPowerPolicyStateForTests, isScreenLocked } from "../powerPolicyState";
import { useNotificationStore } from "../../store/notificationStore";
import { useNotificationHistoryStore } from "../../store/slices/notificationHistorySlice";
import { useNotificationSettingsStore } from "../../store/notificationSettingsStore";

let pushPolicy: ((snapshot: PowerPolicySnapshot) => void) | null = null;

function policy(screenLocked: boolean): PowerPolicySnapshot {
  return {
    level: screenLocked ? "deep" : "active",
    canObserve: !screenLocked,
    onBattery: false,
    screenLocked,
    anyWindowFocused: true,
    anyWindowVisible: true,
  };
}

function setScreenLocked(locked: boolean): void {
  isScreenLocked();
  pushPolicy!(policy(locked));
}

const toasts = () => useNotificationStore.getState().notifications;
const entries = () => useNotificationHistoryStore.getState().entries;

describe("notify() on a locked screen (#14885)", () => {
  beforeEach(() => {
    pushPolicy = null;
    Object.defineProperty(window, "electron", {
      value: {
        notification: { showNative: vi.fn(), setSettings: vi.fn().mockResolvedValue(undefined) },
        events: {
          on: (name: string, cb: (snapshot: PowerPolicySnapshot) => void) => {
            if (name === "system:power-policy-changed") pushPolicy = cb;
            return () => {};
          },
        },
      },
      writable: true,
      configurable: true,
    });
    useNotificationStore.setState({ notifications: [] });
    useNotificationHistoryStore.setState({ entries: [], unreadCount: 0 });
    useNotificationSettingsStore.setState({
      enabled: true,
      hydrated: true,
      quietHoursEnabled: false,
      quietHoursStartMin: 22 * 60,
      quietHoursEndMin: 8 * 60,
      quietHoursWeekdays: [],
    });
    _resetCoalesceMap();
    _resetRateLimitBuckets();
    _setQuietUntil(0);
    // A locked screen fires no blur: the window still reports focus.
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    __resetPowerPolicyStateForTests();
    _resetActiveContextAccessorsForTest();
    _resetPendingSuppressedForTest();
  });

  it("routes a high-priority entry inbox-only and unread", () => {
    setScreenLocked(true);

    notify({ type: "error", message: "Build failed", priority: "high" });

    expect(toasts()).toHaveLength(0);
    expect(entries()).toHaveLength(1);
    expect(entries()[0]!.seenAsToast).toBe(false);
    expect(useNotificationHistoryStore.getState().unreadCount).toBe(1);
  });

  it("toasts again once the screen unlocks", () => {
    setScreenLocked(true);
    setScreenLocked(false);

    notify({ type: "error", message: "Build failed", priority: "high" });

    expect(toasts()).toHaveLength(1);
    expect(entries()[0]!.seenAsToast).toBe(true);
  });

  it("keeps a thread escalation inbox-only and unread", () => {
    notify({ type: "info", correlationId: "build", message: "Building", priority: "low" });
    setScreenLocked(true);

    notify({ type: "warning", correlationId: "build", message: "Build degraded", priority: "low" });

    expect(toasts()).toHaveLength(0);
    expect(entries().find((e) => e.message === "Build degraded")?.seenAsToast).toBe(false);
  });

  it("doesn't count an entry for a visible origin as seen", () => {
    setActiveContextAccessors({
      getActiveWorktreeId: () => "wt-1",
      getFocusedPanelId: () => null,
      subscribeActiveContext: () => () => {},
    });
    setScreenLocked(true);

    notify({
      type: "success",
      message: "Agent finished",
      priority: "high",
      suppressWhenOriginVisible: true,
      context: { worktreeId: "wt-1" },
    });

    expect(toasts()).toHaveLength(0);
    expect(entries()[0]!.seenAsToast).toBe(false);
  });

  it("still toasts a watch entry, which the toaster holds until the user is back", () => {
    setScreenLocked(true);

    notify({ type: "info", message: "Agent waiting", priority: "watch" });

    expect(toasts()).toHaveLength(1);
  });
});

describe("notify() suppression grace across a screen lock (#14885)", () => {
  let activeWorktreeId: string | null = null;
  let contextListeners: Array<() => void> = [];
  let focusSpy: ReturnType<typeof vi.spyOn>;

  function raiseOnVisibleOrigin(): void {
    activeWorktreeId = "wt-1";
    notify({
      type: "info",
      message: "Agent finished",
      priority: "high",
      context: { worktreeId: "wt-1" },
      suppressWhenOriginVisible: true,
    });
    expect(toasts()).toHaveLength(0);
  }

  function navigateAway(): void {
    activeWorktreeId = "wt-2";
    for (const cb of contextListeners) cb();
  }

  beforeEach(() => {
    vi.useFakeTimers();
    pushPolicy = null;
    Object.defineProperty(window, "electron", {
      value: {
        notification: { showNative: vi.fn(), setSettings: vi.fn().mockResolvedValue(undefined) },
        events: {
          on: (name: string, cb: (snapshot: PowerPolicySnapshot) => void) => {
            if (name === "system:power-policy-changed") pushPolicy = cb;
            return () => {};
          },
        },
      },
      writable: true,
      configurable: true,
    });
    useNotificationStore.setState({ notifications: [] });
    useNotificationHistoryStore.setState({ entries: [], unreadCount: 0 });
    useNotificationSettingsStore.setState({
      enabled: true,
      hydrated: true,
      quietHoursEnabled: false,
      quietHoursWeekdays: [],
    });
    _resetCoalesceMap();
    _resetRateLimitBuckets();
    _setQuietUntil(0);
    activeWorktreeId = null;
    contextListeners = [];
    setActiveContextAccessors({
      getActiveWorktreeId: () => activeWorktreeId,
      getFocusedPanelId: () => null,
      subscribeActiveContext: (cb) => {
        contextListeners.push(cb);
        return () => {
          contextListeners = contextListeners.filter((fn) => fn !== cb);
        };
      },
    });
    focusSpy = vi.spyOn(document, "hasFocus").mockReturnValue(true);
  });

  afterEach(() => {
    _resetPendingSuppressedForTest();
    _resetActiveContextAccessorsForTest();
    __resetPowerPolicyStateForTests();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("holds the grace through the lock and promotes on unlock once the origin is gone", () => {
    raiseOnVisibleOrigin();
    setScreenLocked(true);
    vi.advanceTimersByTime(5_000);
    // A context change on the locked screen must not toast onto it.
    navigateAway();
    expect(toasts()).toHaveLength(0);

    setScreenLocked(false);

    expect(toasts()).toHaveLength(1);
    expect(toasts()[0]!.message).toBe("Agent finished");
  });

  it("restarts the grace when the unlock returns to the origin", () => {
    raiseOnVisibleOrigin();
    setScreenLocked(true);
    vi.advanceTimersByTime(5_000);

    setScreenLocked(false);
    expect(toasts()).toHaveLength(0);
    vi.advanceTimersByTime(501);
    navigateAway();

    expect(toasts()).toHaveLength(0);
  });

  it("treats focus on a still-locked screen as no return", () => {
    raiseOnVisibleOrigin();
    setScreenLocked(true);
    activeWorktreeId = "wt-2";
    window.dispatchEvent(new Event("focus"));
    expect(toasts()).toHaveLength(0);

    setScreenLocked(false);

    expect(toasts()).toHaveLength(1);
  });

  it("leaves an unlock into a blurred window to the refocus", () => {
    raiseOnVisibleOrigin();
    setScreenLocked(true);
    activeWorktreeId = "wt-2";
    focusSpy.mockReturnValue(false);
    setScreenLocked(false);
    expect(toasts()).toHaveLength(0);

    focusSpy.mockReturnValue(true);
    window.dispatchEvent(new Event("focus"));

    expect(toasts()).toHaveLength(1);
  });
});
