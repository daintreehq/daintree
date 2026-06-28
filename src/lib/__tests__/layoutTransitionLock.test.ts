// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  __resetSidebarHydrationLockForTests,
  __resetSidebarLayoutTransitionLockForTests,
  isSidebarHydrationLocked,
  isSidebarLayoutTransitionLocked,
  isSidebarMeasurementLocked,
  lockSidebarLayoutTransition,
  subscribeSidebarHydrationUnlock,
  subscribeSidebarLayoutTransitionUnlock,
  unlockSidebarHydration,
} from "../layoutTransitionLock";

describe("layoutTransitionLock", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetSidebarLayoutTransitionLockForTests();
  });

  afterEach(() => {
    __resetSidebarLayoutTransitionLockForTests();
    vi.useRealTimers();
  });

  it("starts unlocked", () => {
    expect(isSidebarLayoutTransitionLocked()).toBe(false);
  });

  it("becomes locked synchronously and unlocks after the duration", () => {
    lockSidebarLayoutTransition(250);
    expect(isSidebarLayoutTransitionLocked()).toBe(true);

    vi.advanceTimersByTime(249);
    expect(isSidebarLayoutTransitionLocked()).toBe(true);

    vi.advanceTimersByTime(1);
    expect(isSidebarLayoutTransitionLocked()).toBe(false);
  });

  it("resets the timer when locked again before expiry", () => {
    lockSidebarLayoutTransition(250);
    vi.advanceTimersByTime(200);
    expect(isSidebarLayoutTransitionLocked()).toBe(true);

    lockSidebarLayoutTransition(250);
    vi.advanceTimersByTime(200);
    expect(isSidebarLayoutTransitionLocked()).toBe(true);

    vi.advanceTimersByTime(50);
    expect(isSidebarLayoutTransitionLocked()).toBe(false);
  });

  it("notifies subscribers when the lock expires", () => {
    const listener = vi.fn();
    subscribeSidebarLayoutTransitionUnlock(listener);

    lockSidebarLayoutTransition(100);
    expect(listener).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(isSidebarLayoutTransitionLocked()).toBe(false);
  });

  it("does not invoke listeners on the lock call itself, only on unlock", () => {
    const listener = vi.fn();
    subscribeSidebarLayoutTransitionUnlock(listener);

    lockSidebarLayoutTransition(100);
    lockSidebarLayoutTransition(100);
    lockSidebarLayoutTransition(100);
    expect(listener).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("notifies multiple subscribers", () => {
    const a = vi.fn();
    const b = vi.fn();
    subscribeSidebarLayoutTransitionUnlock(a);
    subscribeSidebarLayoutTransitionUnlock(b);

    lockSidebarLayoutTransition(50);
    vi.advanceTimersByTime(50);

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("unsubscribe prevents the callback from firing", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSidebarLayoutTransitionUnlock(listener);
    unsubscribe();

    lockSidebarLayoutTransition(50);
    vi.advanceTimersByTime(50);

    expect(listener).not.toHaveBeenCalled();
  });

  it("survives a listener that throws and still notifies the others", () => {
    const ok = vi.fn();
    subscribeSidebarLayoutTransitionUnlock(() => {
      throw new Error("boom");
    });
    subscribeSidebarLayoutTransitionUnlock(ok);

    lockSidebarLayoutTransition(50);
    vi.advanceTimersByTime(50);

    expect(ok).toHaveBeenCalledTimes(1);
    expect(isSidebarLayoutTransitionLocked()).toBe(false);
  });

  it("tolerates a subscriber that unsubscribes from inside its own callback", () => {
    const a = vi.fn();
    const unsubscribeA = vi.fn(() => unsubscribeAFn());
    let unsubscribeAFn: () => void = () => {};

    unsubscribeAFn = subscribeSidebarLayoutTransitionUnlock(() => {
      a();
      unsubscribeA();
    });

    const b = vi.fn();
    subscribeSidebarLayoutTransitionUnlock(b);

    lockSidebarLayoutTransition(50);
    vi.advanceTimersByTime(50);

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("notifies subscribers exactly once when re-locked before expiry (covers rapid double-toggle)", () => {
    const listener = vi.fn();
    subscribeSidebarLayoutTransitionUnlock(listener);

    lockSidebarLayoutTransition(250);
    vi.advanceTimersByTime(200);
    lockSidebarLayoutTransition(250);

    vi.advanceTimersByTime(200);
    expect(listener).not.toHaveBeenCalled();
    expect(isSidebarLayoutTransitionLocked()).toBe(true);

    vi.advanceTimersByTime(50);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(isSidebarLayoutTransitionLocked()).toBe(false);
  });

  it("__resetSidebarLayoutTransitionLockForTests clears the lock and listeners", () => {
    const listener = vi.fn();
    subscribeSidebarLayoutTransitionUnlock(listener);
    lockSidebarLayoutTransition(250);
    expect(isSidebarLayoutTransitionLocked()).toBe(true);

    __resetSidebarLayoutTransitionLockForTests();
    expect(isSidebarLayoutTransitionLocked()).toBe(false);

    vi.advanceTimersByTime(250);
    expect(listener).not.toHaveBeenCalled();
  });
});

// Issue #10827 — the one-shot startup hydration lock. Distinct from the
// transition lock: it starts locked, releases exactly once when the persisted
// sidebar width is restored, and never re-arms.
describe("layoutTransitionLock sidebar hydration lock", () => {
  beforeEach(() => {
    __resetSidebarHydrationLockForTests();
  });

  afterEach(() => {
    __resetSidebarHydrationLockForTests();
  });

  it("starts locked", () => {
    expect(isSidebarHydrationLocked()).toBe(true);
  });

  it("unlocks on the first call and stays unlocked", () => {
    unlockSidebarHydration();
    expect(isSidebarHydrationLocked()).toBe(false);
    unlockSidebarHydration();
    expect(isSidebarHydrationLocked()).toBe(false);
  });

  it("notifies subscribers exactly once on unlock", () => {
    const listener = vi.fn();
    subscribeSidebarHydrationUnlock(listener);
    expect(listener).not.toHaveBeenCalled();

    unlockSidebarHydration();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does not fire subscribers a second time on a repeated unlock", () => {
    const listener = vi.fn();
    subscribeSidebarHydrationUnlock(listener);

    unlockSidebarHydration();
    unlockSidebarHydration();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("notifies multiple subscribers", () => {
    const a = vi.fn();
    const b = vi.fn();
    subscribeSidebarHydrationUnlock(a);
    subscribeSidebarHydrationUnlock(b);

    unlockSidebarHydration();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("unsubscribe before unlock prevents the callback from firing", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSidebarHydrationUnlock(listener);
    unsubscribe();

    unlockSidebarHydration();
    expect(listener).not.toHaveBeenCalled();
  });

  it("fires synchronously and returns a no-op cleanup when already unlocked", () => {
    unlockSidebarHydration();

    const listener = vi.fn();
    const unsubscribe = subscribeSidebarHydrationUnlock(listener);
    // Already-unlocked fast path: a measurement effect mounting after restore
    // still gets its deferred remeasure instead of silently dropping it.
    expect(listener).toHaveBeenCalledTimes(1);
    expect(() => unsubscribe()).not.toThrow();
  });

  it("survives a listener that throws and still notifies the others", () => {
    const ok = vi.fn();
    subscribeSidebarHydrationUnlock(() => {
      throw new Error("boom");
    });
    subscribeSidebarHydrationUnlock(ok);

    unlockSidebarHydration();
    expect(ok).toHaveBeenCalledTimes(1);
    expect(isSidebarHydrationLocked()).toBe(false);
  });

  it("stays locked and silent until unlock is called (covers a hung width-restore IPC)", () => {
    const listener = vi.fn();
    subscribeSidebarHydrationUnlock(listener);

    // No unlock — mirrors appClient.getState() hanging without resolve/reject.
    expect(isSidebarHydrationLocked()).toBe(true);
    expect(listener).not.toHaveBeenCalled();
  });

  it("survives a throwing listener on the already-unlocked fast path", () => {
    unlockSidebarHydration();
    expect(() =>
      subscribeSidebarHydrationUnlock(() => {
        throw new Error("boom");
      })
    ).not.toThrow();
  });

  it("__resetSidebarHydrationLockForTests re-arms the lock and drops pending listeners", () => {
    const listener = vi.fn();
    subscribeSidebarHydrationUnlock(listener);

    __resetSidebarHydrationLockForTests();
    expect(isSidebarHydrationLocked()).toBe(true);

    unlockSidebarHydration();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("isSidebarMeasurementLocked", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetSidebarLayoutTransitionLockForTests();
    __resetSidebarHydrationLockForTests();
  });

  afterEach(() => {
    __resetSidebarLayoutTransitionLockForTests();
    __resetSidebarHydrationLockForTests();
    vi.useRealTimers();
  });

  it("is true while only the hydration lock is active", () => {
    expect(isSidebarLayoutTransitionLocked()).toBe(false);
    expect(isSidebarHydrationLocked()).toBe(true);
    expect(isSidebarMeasurementLocked()).toBe(true);
  });

  it("is true while only the transition lock is active", () => {
    unlockSidebarHydration();
    lockSidebarLayoutTransition(100);
    expect(isSidebarHydrationLocked()).toBe(false);
    expect(isSidebarLayoutTransitionLocked()).toBe(true);
    expect(isSidebarMeasurementLocked()).toBe(true);
  });

  it("is true while both locks are active", () => {
    lockSidebarLayoutTransition(100);
    expect(isSidebarMeasurementLocked()).toBe(true);
  });

  it("is false only once both locks have cleared", () => {
    unlockSidebarHydration();
    lockSidebarLayoutTransition(100);
    expect(isSidebarMeasurementLocked()).toBe(true);

    vi.advanceTimersByTime(100);
    expect(isSidebarLayoutTransitionLocked()).toBe(false);
    expect(isSidebarHydrationLocked()).toBe(false);
    expect(isSidebarMeasurementLocked()).toBe(false);
  });
});
