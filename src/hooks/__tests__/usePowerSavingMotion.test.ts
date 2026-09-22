// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { PowerPolicySnapshot } from "@shared/types/powerPolicy";

type LifecyclePhase = "cached" | "active" | "revealed";

const lifecycle = vi.hoisted(() => ({
  cached: false,
  listeners: new Set<(phase: LifecyclePhase) => void>(),
}));

// Every runtime export: a factory is a strict surface.
vi.mock("@/lib/viewCacheState", () => ({
  subscribeProjectViewLifecycle: (listener: (phase: LifecyclePhase) => void) => {
    lifecycle.listeners.add(listener);
    return () => {
      lifecycle.listeners.delete(listener);
    };
  },
  isProjectViewCached: () => lifecycle.cached,
  __resetProjectViewCacheStateForTests: () => {
    lifecycle.listeners.clear();
  },
}));

import { StrictMode } from "react";
import {
  loopingMotionMode,
  resetPowerSavingMotionForTests,
  usePowerSavingMotion,
} from "../usePowerSavingMotion";
import { useResourceProfileStore } from "@/store/resourceProfileStore";

const eventsOnMock = vi.fn();
let pushPolicy: ((snapshot: PowerPolicySnapshot) => void) | null = null;

function snapshot(level: PowerPolicySnapshot["level"]): PowerPolicySnapshot {
  return {
    level,
    canObserve: level === "active",
    onBattery: level === "saving",
    screenLocked: level === "deep",
    anyWindowFocused: level === "active",
    anyWindowVisible: level !== "deep",
  };
}

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

const powerSaving = () => document.body.dataset.powerSaving;
const motionRate = () => document.body.dataset.motionRate;

describe("loopingMotionMode", () => {
  const base = {
    powerLevel: "active",
    profile: "balanced",
    viewCached: false,
    documentHidden: false,
  } as const;

  it("runs at full rate in the foreground on AC", () => {
    expect(loopingMotionMode(base)).toBe("full");
  });

  it.each([
    ["battery or a blurred window (saving)", { powerLevel: "saving" }],
    ["the efficiency profile", { profile: "efficiency" }],
  ] as const)("slows but never stops a window that can still be seen: %s", (_label, overrides) => {
    expect(loopingMotionMode({ ...base, ...overrides })).toBe("reduced");
  });

  it.each([
    ["locked or hidden (deep)", { powerLevel: "deep" }],
    ["a cached view", { viewCached: true }],
    ["a hidden document", { documentHidden: true }],
  ] as const)("stops only where nothing can be seen: %s", (_label, overrides) => {
    expect(loopingMotionMode({ ...base, ...overrides })).toBe("stopped");
    expect(loopingMotionMode({ ...base, powerLevel: "saving", ...overrides })).toBe("stopped");
  });
});

describe("usePowerSavingMotion", () => {
  beforeEach(() => {
    pushPolicy = null;
    lifecycle.cached = false;
    lifecycle.listeners.clear();
    eventsOnMock.mockReset();
    eventsOnMock.mockImplementation((name: string, cb: (payload: PowerPolicySnapshot) => void) => {
      if (name === "system:power-policy-changed") pushPolicy = cb;
      return vi.fn();
    });
    Object.defineProperty(window, "electron", {
      configurable: true,
      writable: true,
      value: { events: { on: eventsOnMock } },
    });
    useResourceProfileStore.getState().setProfile("balanced");
    setVisibility("visible");
  });

  afterEach(() => {
    Reflect.deleteProperty(window, "electron");
    delete document.body.dataset.powerSaving;
    delete document.body.dataset.motionRate;
    resetPowerSavingMotionForTests();
  });

  it("keeps a policy replayed before mount across StrictMode's effect re-run", () => {
    // The preload replays a pre-subscriber push once, to the first subscriber.
    let buffered: PowerPolicySnapshot | null = snapshot("saving");
    eventsOnMock.mockImplementation((name: string, cb: (payload: PowerPolicySnapshot) => void) => {
      if (name === "system:power-policy-changed" && buffered) {
        const replay = buffered;
        buffered = null;
        cb(replay);
      }
      return vi.fn();
    });

    renderHook(() => usePowerSavingMotion(), { wrapper: StrictMode });

    expect(motionRate()).toBe("reduced");
  });

  it("follows main's power policy, including the way back", () => {
    renderHook(() => usePowerSavingMotion());
    expect(powerSaving()).toBeUndefined();

    act(() => pushPolicy!(snapshot("saving")));
    expect(motionRate()).toBe("reduced");
    expect(powerSaving()).toBeUndefined();

    act(() => pushPolicy!(snapshot("deep")));
    expect(motionRate()).toBeUndefined();
    expect(powerSaving()).toBe("true");

    act(() => pushPolicy!(snapshot("active")));
    expect(motionRate()).toBeUndefined();
    expect(powerSaving()).toBeUndefined();
  });

  it("stops looping motion while the view is cached and restores it on reveal", () => {
    renderHook(() => usePowerSavingMotion());

    lifecycle.cached = true;
    act(() => lifecycle.listeners.forEach((listener) => listener("cached")));
    expect(powerSaving()).toBe("true");

    lifecycle.cached = false;
    act(() => lifecycle.listeners.forEach((listener) => listener("revealed")));
    expect(powerSaving()).toBeUndefined();

    // Cached outranks slowed, and reveal hands the slowed state back intact.
    act(() => pushPolicy!(snapshot("saving")));
    lifecycle.cached = true;
    act(() => lifecycle.listeners.forEach((listener) => listener("cached")));
    expect([powerSaving(), motionRate()]).toEqual(["true", undefined]);
    lifecycle.cached = false;
    act(() => lifecycle.listeners.forEach((listener) => listener("revealed")));
    expect([powerSaving(), motionRate()]).toEqual([undefined, "reduced"]);
  });

  it("tracks the efficiency profile and page visibility", () => {
    renderHook(() => usePowerSavingMotion());

    act(() => useResourceProfileStore.getState().setProfile("efficiency"));
    expect(motionRate()).toBe("reduced");
    expect(powerSaving()).toBeUndefined();

    // Hidden outranks slowed: nothing to see, so nothing runs.
    act(() => setVisibility("hidden"));
    expect(motionRate()).toBeUndefined();
    expect(powerSaving()).toBe("true");
    act(() => setVisibility("visible"));
    expect(motionRate()).toBe("reduced");
    expect(powerSaving()).toBeUndefined();

    act(() => useResourceProfileStore.getState().setProfile("balanced"));
    expect(motionRate()).toBeUndefined();

    act(() => setVisibility("hidden"));
    expect(powerSaving()).toBe("true");
    act(() => setVisibility("visible"));
    expect(powerSaving()).toBeUndefined();
  });

  it("clears both attributes and its subscriptions on unmount", () => {
    const { unmount } = renderHook(() => usePowerSavingMotion());
    act(() => pushPolicy!(snapshot("deep")));
    expect(powerSaving()).toBe("true");
    unmount();
    expect(powerSaving()).toBeUndefined();

    const second = renderHook(() => usePowerSavingMotion());
    act(() => pushPolicy!(snapshot("saving")));
    expect(motionRate()).toBe("reduced");
    second.unmount();
    expect(motionRate()).toBeUndefined();
    expect(lifecycle.listeners.size).toBe(0);
  });

  it("aligns existing and newly started spinners without changing other animations", () => {
    const icon = document.createElement("div");
    icon.className = "animate-spin-slow";
    const duration = 1400;
    const spinner = {
      animationName: "spin-slow",
      startTime: 123,
      effect: { getTiming: () => ({ duration }) },
    };
    const transition = { startTime: 456 };
    Object.defineProperty(icon, "getAnimations", { value: () => [spinner, transition] });
    document.body.append(icon);
    const { unmount } = renderHook(() => usePowerSavingMotion());
    expect((performance.timeOrigin + spinner.startTime) % duration).toBeCloseTo(0);
    expect(transition.startTime).toBe(456);

    const start = () => {
      const event = new Event("animationstart", { bubbles: true });
      Object.defineProperty(event, "animationName", { value: "spin-slow" });
      icon.dispatchEvent(event);
    };
    spinner.startTime = 789;
    start();
    expect((performance.timeOrigin + spinner.startTime) % duration).toBeCloseTo(0);
    unmount();
    spinner.startTime = 999;
    start();
    expect(spinner.startTime).toBe(999);
    icon.remove();
  });
});
