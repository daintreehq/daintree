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
  resetPowerSavingMotionForTests,
  shouldSuspendDecorativeMotion,
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

describe("shouldSuspendDecorativeMotion", () => {
  const base = {
    powerLevel: "active",
    profile: "balanced",
    viewCached: false,
    documentHidden: false,
  } as const;

  it("keeps looping motion in the foreground on AC", () => {
    expect(shouldSuspendDecorativeMotion(base)).toBe(false);
  });

  it.each([
    ["battery or blur (saving)", { powerLevel: "saving" }],
    ["locked or hidden (deep)", { powerLevel: "deep" }],
    ["the efficiency profile", { profile: "efficiency" }],
    ["a cached view", { viewCached: true }],
    ["a hidden document", { documentHidden: true }],
  ] as const)("stops it for %s", (_label, overrides) => {
    expect(shouldSuspendDecorativeMotion({ ...base, ...overrides })).toBe(true);
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

    expect(powerSaving()).toBe("true");
  });

  it("follows main's power policy, including the way back", () => {
    renderHook(() => usePowerSavingMotion());
    expect(powerSaving()).toBeUndefined();

    act(() => pushPolicy!(snapshot("saving")));
    expect(powerSaving()).toBe("true");

    act(() => pushPolicy!(snapshot("active")));
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
  });

  it("tracks the efficiency profile and page visibility", () => {
    renderHook(() => usePowerSavingMotion());

    act(() => useResourceProfileStore.getState().setProfile("efficiency"));
    expect(powerSaving()).toBe("true");
    act(() => useResourceProfileStore.getState().setProfile("balanced"));
    expect(powerSaving()).toBeUndefined();

    act(() => setVisibility("hidden"));
    expect(powerSaving()).toBe("true");
    act(() => setVisibility("visible"));
    expect(powerSaving()).toBeUndefined();
  });

  it("clears the attribute and its subscriptions on unmount", () => {
    const { unmount } = renderHook(() => usePowerSavingMotion());
    act(() => pushPolicy!(snapshot("deep")));
    expect(powerSaving()).toBe("true");

    unmount();

    expect(powerSaving()).toBeUndefined();
    expect(lifecycle.listeners.size).toBe(0);
  });
});
