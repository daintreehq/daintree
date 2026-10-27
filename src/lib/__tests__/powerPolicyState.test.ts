// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PowerPolicySnapshot } from "@shared/types/powerPolicy";
import {
  __resetPowerPolicyStateForTests,
  getPowerPolicyLevel,
  isScreenLocked,
  subscribePowerPolicyLevel,
  subscribeScreenLock,
} from "../powerPolicyState";

function snapshot(overrides: Partial<PowerPolicySnapshot> = {}): PowerPolicySnapshot {
  return {
    level: "active",
    canObserve: true,
    onBattery: false,
    screenLocked: false,
    anyWindowFocused: true,
    anyWindowVisible: true,
    ...overrides,
  };
}

const locked = snapshot({ level: "deep", canObserve: false, screenLocked: true });

let push: ((snapshot: PowerPolicySnapshot) => void) | null = null;
const on = vi.fn();

function installBridge(replay?: PowerPolicySnapshot): void {
  // Like preload: a buffered push replays once, synchronously, to the first subscriber.
  let buffered = replay ?? null;
  on.mockImplementation((name: string, cb: (snapshot: PowerPolicySnapshot) => void) => {
    if (name !== "system:power-policy-changed") return () => {};
    push = cb;
    if (buffered) {
      const value = buffered;
      buffered = null;
      cb(value);
    }
    return () => {
      push = null;
    };
  });
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: { events: { on } },
  });
}

describe("powerPolicyState", () => {
  beforeEach(() => {
    push = null;
    on.mockReset();
  });

  afterEach(() => {
    __resetPowerPolicyStateForTests();
    Reflect.deleteProperty(window, "electron");
  });

  it("answers the boot default without a bridge, and arms once one appears", () => {
    expect(isScreenLocked()).toBe(false);
    expect(getPowerPolicyLevel()).toBe("active");

    installBridge(locked);

    expect(isScreenLocked()).toBe(true);
    expect(getPowerPolicyLevel()).toBe("deep");
    expect(on).toHaveBeenCalledTimes(1);
  });

  it("gives every reader the push replayed to the first", () => {
    installBridge(locked);
    const lockListener = vi.fn();

    expect(getPowerPolicyLevel()).toBe("deep");
    subscribeScreenLock(lockListener);

    expect(isScreenLocked()).toBe(true);
    expect(on).toHaveBeenCalledTimes(1);
    expect(lockListener).not.toHaveBeenCalled();
  });

  it("subscribes once when a listener reads state during the replay", () => {
    // Subscribed before the bridge existed, so it hears the replay while arming.
    const reads: boolean[] = [];
    subscribeScreenLock(() => reads.push(isScreenLocked()));
    installBridge(locked);

    isScreenLocked();

    expect(reads).toEqual([true]);
    expect(on).toHaveBeenCalledTimes(1);
  });

  it("fires lock listeners on edges only", () => {
    installBridge();
    const lockListener = vi.fn();
    subscribeScreenLock(lockListener);

    push!(locked);
    push!(locked);
    push!(snapshot({ level: "deep", canObserve: false, screenLocked: true, onBattery: true }));
    push!(snapshot({ level: "saving", anyWindowFocused: false }));

    expect(lockListener.mock.calls).toEqual([[true], [false]]);
  });

  it("fires level listeners on level changes only, with the lock already settled", () => {
    installBridge();
    const seen: Array<[string, boolean]> = [];
    const lockEdges: boolean[] = [];
    subscribePowerPolicyLevel((level) => seen.push([level, isScreenLocked()]));
    subscribeScreenLock((isLocked) => lockEdges.push(isLocked));

    push!(snapshot({ onBattery: false, anyWindowFocused: true }));
    push!(locked);
    // Unlocked with the window hidden: still deep, no longer locked.
    push!(snapshot({ level: "deep", screenLocked: false, anyWindowVisible: false }));

    expect(seen).toEqual([["deep", true]]);
    expect(lockEdges).toEqual([true, false]);
    expect(isScreenLocked()).toBe(false);
  });

  it("reads a deep policy with no lock as unlocked", () => {
    installBridge(snapshot({ level: "deep", canObserve: false, anyWindowVisible: false }));

    expect(getPowerPolicyLevel()).toBe("deep");
    expect(isScreenLocked()).toBe(false);
  });

  it("tries again after a subscription that throws", () => {
    on.mockImplementationOnce(() => {
      throw new Error("bridge not ready");
    });
    Object.defineProperty(window, "electron", {
      configurable: true,
      writable: true,
      value: { events: { on } },
    });
    expect(isScreenLocked()).toBe(false);

    installBridge(locked);

    expect(isScreenLocked()).toBe(true);
  });

  it("keeps notifying the others when one listener throws", () => {
    installBridge();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const after = vi.fn();
    subscribeScreenLock(() => {
      throw new Error("boom");
    });
    subscribeScreenLock(after);

    push!(locked);

    expect(after).toHaveBeenCalledWith(true);
    errorSpy.mockRestore();
  });

  it("stops notifying a listener once it unsubscribes", () => {
    installBridge();
    const listener = vi.fn();
    const off = subscribeScreenLock(listener);
    off();

    push!(locked);

    expect(listener).not.toHaveBeenCalled();
    expect(isScreenLocked()).toBe(true);
  });
});
