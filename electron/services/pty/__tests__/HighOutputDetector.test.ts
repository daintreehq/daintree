import { describe, it, expect, beforeEach } from "vitest";
import { HighOutputDetector } from "../HighOutputDetector.js";

describe("HighOutputDetector", () => {
  it("returns false when disabled", () => {
    const d = new HighOutputDetector({ enabled: false });
    d.update(10000, 1000);
    expect(d.isHighOutput(1000)).toBe(false);
    expect(d.shouldTriggerRecovery(1000)).toBe(false);
  });

  describe("isHighOutput", () => {
    let detector: HighOutputDetector;

    beforeEach(() => {
      detector = new HighOutputDetector({
        enabled: true,
        windowMs: 500,
        bytesPerSecond: 2048,
        recoveryEnabled: true,
        recoveryDelayMs: 500,
      });
    });

    it("returns false with no data", () => {
      expect(detector.isHighOutput(1000)).toBe(false);
    });

    it("returns true when rate exceeds threshold", () => {
      detector.update(5000, 1000);
      expect(detector.isHighOutput(1050)).toBe(true);
    });

    it("returns false when rate is below threshold", () => {
      detector.update(50, 1000);
      expect(detector.isHighOutput(1050)).toBe(false);
    });

    it("returns false after window expires", () => {
      detector.update(5000, 1000);
      expect(detector.isHighOutput(1600)).toBe(false);
    });

    it("accumulates bytes within window", () => {
      detector.update(1000, 1000);
      detector.update(2000, 1100);
      expect(detector.isHighOutput(1100)).toBe(true);
    });
  });

  describe("shouldTriggerRecovery", () => {
    let detector: HighOutputDetector;

    beforeEach(() => {
      detector = new HighOutputDetector({
        enabled: true,
        windowMs: 500,
        bytesPerSecond: 2048,
        recoveryEnabled: true,
        recoveryDelayMs: 500,
      });
    });

    it("returns false when recovery disabled", () => {
      const d = new HighOutputDetector({
        enabled: true,
        recoveryEnabled: false,
      });
      d.update(10000, 1000);
      expect(d.shouldTriggerRecovery(1050)).toBe(false);
    });

    it("returns false before sustained duration", () => {
      detector.update(5000, 1000);
      expect(detector.shouldTriggerRecovery(1050)).toBe(false);
    });

    it("returns true after sustained duration", () => {
      // Use longer window so it doesn't expire during the recovery delay
      const d = new HighOutputDetector({
        enabled: true,
        windowMs: 1000,
        bytesPerSecond: 2048,
        recoveryEnabled: true,
        recoveryDelayMs: 500,
      });
      d.update(5000, 1000);
      d.shouldTriggerRecovery(1050); // Start sustained tracking
      d.update(5000, 1300); // Keep accumulating within window
      expect(d.shouldTriggerRecovery(1550)).toBe(true); // 1550-1050 = 500 >= recoveryDelayMs
    });

    it("resets when output drops", () => {
      detector.update(5000, 1000);
      detector.shouldTriggerRecovery(1050); // Start tracking
      // No new data — window expires, output drops
      expect(detector.shouldTriggerRecovery(1600)).toBe(false);
    });

    it("reset clears all state", () => {
      detector.update(5000, 1000);
      detector.shouldTriggerRecovery(1050);
      detector.reset();
      expect(detector.isHighOutput(1100)).toBe(false);
    });
  });
});
