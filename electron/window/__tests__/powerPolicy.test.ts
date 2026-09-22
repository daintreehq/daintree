import { afterEach, describe, expect, it, vi } from "vitest";
import {
  derivePowerPolicy,
  powerPolicyPollMultiplier,
  type PowerObservations,
} from "../../../shared/types/powerPolicy.js";
import {
  getPowerPolicy,
  resetPowerPolicyForTesting,
  subscribePowerPolicy,
  updatePowerObservations,
} from "../powerPolicy.js";

const FOREGROUND: PowerObservations = {
  onBattery: false,
  screenLocked: false,
  anyWindowFocused: true,
  anyWindowVisible: true,
};

describe("derivePowerPolicy", () => {
  it.each([
    ["AC, focused, visible", {}, "active", true, 1],
    ["battery, focused", { onBattery: true }, "saving", true, 2],
    ["AC, blurred", { anyWindowFocused: false }, "saving", false, 5],
    ["battery, blurred", { onBattery: true, anyWindowFocused: false }, "saving", false, 5],
    ["locked while focused", { screenLocked: true }, "deep", false, 10],
    ["every window hidden", { anyWindowVisible: false }, "deep", false, 10],
    [
      "hidden and blurred on battery",
      { onBattery: true, anyWindowFocused: false, anyWindowVisible: false },
      "deep",
      false,
      10,
    ],
  ] as const)("%s", (_label, overrides, level, canObserve, multiplier) => {
    const snapshot = derivePowerPolicy({ ...FOREGROUND, ...overrides });
    expect(snapshot.level).toBe(level);
    expect(snapshot.canObserve).toBe(canObserve);
    expect(powerPolicyPollMultiplier(snapshot)).toBe(multiplier);
  });
});

describe("power policy state", () => {
  afterEach(() => {
    resetPowerPolicyForTesting();
  });

  it("starts in the foreground so nothing is throttled before the first observation", () => {
    expect(getPowerPolicy()).toMatchObject({ level: "active", canObserve: true });
  });

  it("notifies with the next and previous snapshot on a change", () => {
    const listener = vi.fn();
    subscribePowerPolicy(listener);

    updatePowerObservations({ screenLocked: true });

    expect(listener).toHaveBeenCalledTimes(1);
    const [next, previous] = listener.mock.calls[0];
    expect(next).toMatchObject({ level: "deep", screenLocked: true });
    expect(previous).toMatchObject({ level: "active", screenLocked: false });
  });

  it("stays silent when the observations did not change", () => {
    const listener = vi.fn();
    subscribePowerPolicy(listener);

    updatePowerObservations({ onBattery: false, anyWindowFocused: true });

    expect(listener).not.toHaveBeenCalled();
  });

  it("notifies when observability changes inside the same level", () => {
    updatePowerObservations({ onBattery: true });
    const listener = vi.fn();
    subscribePowerPolicy(listener);

    updatePowerObservations({ anyWindowFocused: false });

    expect(listener).toHaveBeenCalledTimes(1);
    const [next, previous] = listener.mock.calls[0];
    expect(previous).toMatchObject({ level: "saving", canObserve: true });
    expect(next).toMatchObject({ level: "saving", canObserve: false });
  });

  it("keeps notifying the remaining listeners when one throws", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const survivor = vi.fn();
    subscribePowerPolicy(() => {
      throw new Error("boom");
    });
    subscribePowerPolicy(survivor);

    updatePowerObservations({ onBattery: true });

    expect(survivor).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it("stops notifying after unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = subscribePowerPolicy(listener);
    unsubscribe();

    updatePowerObservations({ onBattery: true });

    expect(listener).not.toHaveBeenCalled();
  });
});
