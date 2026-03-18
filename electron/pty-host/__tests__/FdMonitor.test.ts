import { describe, it, expect, vi, beforeEach } from "vitest";

// Must mock before imports
const mockReaddirSync = vi.fn();
const mockExecFileSync = vi.fn();

vi.mock("node:fs", () => ({
  default: { readdirSync: (...args: any[]) => mockReaddirSync(...args) },
  readdirSync: (...args: any[]) => mockReaddirSync(...args),
}));

vi.mock("node:child_process", () => ({
  execFileSync: (...args: any[]) => mockExecFileSync(...args),
}));

import { FdMonitor, isProcessAlive } from "../FdMonitor.js";

describe("FdMonitor", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockReaddirSync.mockReturnValue(["0", "1", "2", "3", "4"]);
    mockExecFileSync.mockReturnValue("511\n");
  });

  describe("getFdCount", () => {
    it("returns count of entries from fd directory", () => {
      const monitor = new FdMonitor();
      mockReaddirSync.mockReturnValue(["0", "1", "2", "3", "4", "5", "6"]);
      expect(monitor.getFdCount()).toBe(7);
    });

    it("returns 0 if readdirSync throws", () => {
      const monitor = new FdMonitor();
      mockReaddirSync.mockImplementation(() => {
        throw new Error("ENOENT");
      });
      expect(monitor.getFdCount()).toBe(0);
    });
  });

  describe("checkForLeaks", () => {
    it("returns no warning when FDs are within threshold", () => {
      // baseline: 5 FDs, current: 15 FDs, 5 active terminals
      // threshold = 5 * 2 + 10 + 5 = 25 → 15 < 25 → no warning
      const monitor = new FdMonitor();
      mockReaddirSync.mockReturnValue(Array.from({ length: 15 }, (_, i) => String(i)));

      const result = monitor.checkForLeaks(5, []);
      expect(result.isWarning).toBe(false);
      expect(result.totalFds).toBe(15);
      expect(result.activeTerminals).toBe(5);
      expect(result.baselineFds).toBe(5);
      expect(result.estimatedTerminalFds).toBe(10);
    });

    it("returns warning when FDs exceed threshold", () => {
      // baseline: 5 FDs, current: 50 FDs, 2 active terminals
      // threshold = 2 * 2 + 10 + 5 = 19 → 50 > 19 → warning
      const monitor = new FdMonitor();
      mockReaddirSync.mockReturnValue(Array.from({ length: 50 }, (_, i) => String(i)));

      const result = monitor.checkForLeaks(2, []);
      expect(result.isWarning).toBe(true);
      expect(result.totalFds).toBe(50);
      expect(result.estimatedTerminalFds).toBe(45);
    });

    it("reports ptmxLimit on macOS", () => {
      const monitor = new FdMonitor();
      const result = monitor.checkForLeaks(0, []);
      if (process.platform === "darwin") {
        expect(result.ptmxLimit).toBe(511);
      }
    });
  });

  describe("orphaned PID detection", () => {
    it("detects alive orphaned PIDs", () => {
      const monitor = new FdMonitor();
      // process.pid is always alive
      const result = monitor.checkForLeaks(1, [process.pid]);
      expect(result.orphanedPids).toContain(process.pid);
    });

    it("does not report dead PIDs as orphaned", () => {
      const monitor = new FdMonitor();
      // PID 99999 is almost certainly dead
      const result = monitor.checkForLeaks(1, [99999]);
      expect(result.orphanedPids).not.toContain(99999);
    });
  });
});

describe("isProcessAlive", () => {
  it("returns true for current process PID", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it("returns false for non-existent PID", () => {
    expect(isProcessAlive(99999)).toBe(false);
  });
});
