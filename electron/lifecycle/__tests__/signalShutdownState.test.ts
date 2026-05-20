import { beforeEach, describe, expect, it, vi } from "vitest";

describe("signalShutdownState", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("starts as false", async () => {
    const { isSignalShutdown } = await import("../signalShutdownState.js");
    expect(isSignalShutdown()).toBe(false);
  });

  it("becomes true after setSignalShutdown", async () => {
    const { isSignalShutdown, setSignalShutdown } = await import("../signalShutdownState.js");
    setSignalShutdown();
    expect(isSignalShutdown()).toBe(true);
  });

  describe("safety-belt timer", () => {
    it("clearSafetyBeltTimer is a no-op when no timer is set", async () => {
      const { clearSafetyBeltTimer } = await import("../signalShutdownState.js");
      // No throw, no side effect — the module starts with the handle null.
      expect(() => clearSafetyBeltTimer()).not.toThrow();
    });

    it("clearSafetyBeltTimer cancels a stored timer so it does not fire", async () => {
      vi.useFakeTimers();
      const { setSafetyBeltTimer, clearSafetyBeltTimer } =
        await import("../signalShutdownState.js");

      const callback = vi.fn();
      const handle = setTimeout(callback, 1000);
      setSafetyBeltTimer(handle);

      clearSafetyBeltTimer();
      vi.advanceTimersByTime(2000);

      expect(callback).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("clearSafetyBeltTimer is idempotent — second call is a no-op", async () => {
      vi.useFakeTimers();
      const { setSafetyBeltTimer, clearSafetyBeltTimer } =
        await import("../signalShutdownState.js");

      const handle = setTimeout(() => {}, 1000);
      setSafetyBeltTimer(handle);
      clearSafetyBeltTimer();
      // Second clear must not throw or attempt to clear a null handle.
      expect(() => clearSafetyBeltTimer()).not.toThrow();
      vi.useRealTimers();
    });

    it("setSafetyBeltTimer(null) clears the stored handle without canceling", async () => {
      vi.useFakeTimers();
      const { setSafetyBeltTimer, clearSafetyBeltTimer } =
        await import("../signalShutdownState.js");

      const callback = vi.fn();
      const handle = setTimeout(callback, 1000);
      setSafetyBeltTimer(handle);

      // Simulate the belt firing and nulling itself — subsequent clear is no-op.
      setSafetyBeltTimer(null);
      clearSafetyBeltTimer();

      vi.advanceTimersByTime(2000);
      // Callback still fires because we nulled the reference without clearing.
      expect(callback).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    });
  });
});
