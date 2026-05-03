import { describe, it, expect, beforeEach } from "vitest";
import { OutputVolumeDetector } from "../OutputVolumeDetector.js";

describe("OutputVolumeDetector", () => {
  it("returns false when disabled", () => {
    const d = new OutputVolumeDetector({ enabled: false });
    expect(d.update(5000, 1000)).toBe(false);
  });

  describe("enabled", () => {
    let detector: OutputVolumeDetector;

    beforeEach(() => {
      detector = new OutputVolumeDetector({
        enabled: true,
        windowMs: 500,
        minFrames: 3,
        minBytes: 2048,
      });
    });

    it("does not trigger below thresholds", () => {
      expect(detector.update(100, 1000)).toBe(false);
      expect(detector.update(100, 1050)).toBe(false);
    });

    it("does not trigger on a single big burst (minFrames not met)", () => {
      // minFrames is a noise gate — a single chunk, no matter how large, must
      // pair with at least one follow-up frame before escalation fires.
      expect(detector.update(3000, 1000)).toBe(false);
    });

    it("triggers when both frame and byte thresholds met", () => {
      detector.update(700, 1000);
      detector.update(700, 1050);
      expect(detector.update(700, 1100)).toBe(true);
    });

    it("does not trigger when frame threshold met but byte threshold missed", () => {
      expect(detector.update(10, 1000)).toBe(false);
      expect(detector.update(10, 1050)).toBe(false);
      expect(detector.update(10, 1100)).toBe(false);
    });

    it("does not trigger on a single byte even at minBytes:1 (split-sequence guard)", () => {
      const d = new OutputVolumeDetector({
        enabled: true,
        windowMs: 500,
        minFrames: 2,
        minBytes: 1,
      });
      expect(d.update(1, 1000)).toBe(false);
    });

    it("triggers on second byte after first at minBytes:1", () => {
      const d = new OutputVolumeDetector({
        enabled: true,
        windowMs: 500,
        minFrames: 2,
        minBytes: 1,
      });
      d.update(1, 1000);
      expect(d.update(1, 1050)).toBe(true);
    });

    it("resets window after expiry", () => {
      detector.update(500, 1000);
      // Window expires after 500ms
      expect(detector.update(500, 1600)).toBe(false);
    });

    it("resets after trigger", () => {
      detector.update(3000, 1000);
      // After trigger, window resets so small data doesn't trigger
      expect(detector.update(100, 1050)).toBe(false);
    });

    it("reset clears state", () => {
      detector.update(1000, 1000);
      detector.reset();
      expect(detector.update(100, 1050)).toBe(false);
    });
  });

  describe("reconfigureWindow", () => {
    it("widens window so frames that straddled the old boundary are detectable", () => {
      const d = new OutputVolumeDetector({
        enabled: true,
        windowMs: 1000,
        minFrames: 2,
        minBytes: 1,
      });
      d.reconfigureWindow(2500);
      d.update(1, 1000);
      // 1700ms later — would have expired the 1000ms window, fits inside 2500ms.
      expect(d.update(1, 2700)).toBe(true);
    });

    it("clears in-flight frame accumulation on reconfigure", () => {
      const d = new OutputVolumeDetector({
        enabled: true,
        windowMs: 1000,
        minFrames: 2,
        minBytes: 1,
      });
      d.update(1, 1000);
      d.reconfigureWindow(2500);
      // Prior frame was discarded — first frame after reconfigure cannot trigger.
      expect(d.update(1, 1050)).toBe(false);
    });

    it("is a no-op when called with the current window size", () => {
      const d = new OutputVolumeDetector({
        enabled: true,
        windowMs: 1000,
        minFrames: 2,
        minBytes: 1,
      });
      d.update(1, 1000);
      d.reconfigureWindow(1000);
      // Same value should preserve in-flight state.
      expect(d.update(1, 1050)).toBe(true);
    });

    it("exposes the current windowMs through the getter", () => {
      const d = new OutputVolumeDetector({ enabled: true, windowMs: 1000 });
      expect(d.windowMs).toBe(1000);
      d.reconfigureWindow(2500);
      expect(d.windowMs).toBe(2500);
    });
  });
});
