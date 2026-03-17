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

    it("triggers when byte threshold met", () => {
      expect(detector.update(3000, 1000)).toBe(true);
    });

    it("triggers when both frame and byte thresholds met", () => {
      detector.update(700, 1000);
      detector.update(700, 1050);
      expect(detector.update(700, 1100)).toBe(true);
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
});
