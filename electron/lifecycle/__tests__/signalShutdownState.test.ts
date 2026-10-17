import { beforeEach, describe, expect, it, vi } from "vitest";

describe("signalShutdownState", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  describe("safety-belt timer", () => {
    it("clearSafetyBeltTimer cancels a stored timer so it does not fire", async () => {
      vi.useFakeTimers();
      const { setSafetyBeltTimer, clearSafetyBeltTimer } =
        await import("../signalShutdownState.js");

      const callback = vi.fn();
      const handle = setTimeout(callback, 1000) as unknown as ReturnType<typeof setTimeout>;
      setSafetyBeltTimer(handle);

      clearSafetyBeltTimer();
      vi.advanceTimersByTime(2000);

      expect(callback).not.toHaveBeenCalled();
      vi.useRealTimers();
    });
  });
});
