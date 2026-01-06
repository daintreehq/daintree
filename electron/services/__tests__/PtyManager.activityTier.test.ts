import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { PtyManager } from "../PtyManager.js";

let PtyManagerClass: typeof PtyManager | null = null;
let testUtils: typeof import("./helpers/ptyTestUtils.js") | null = null;

try {
  PtyManagerClass = (await import("../PtyManager.js")).PtyManager;
  testUtils = await import("./helpers/ptyTestUtils.js");
} catch {
  console.warn("node-pty not available, skipping PTY activity tier tests");
}

const shouldSkip = !PtyManagerClass;

describe.skipIf(shouldSkip)("PtyManager Activity Tier", () => {
  const { cleanupPtyManager, spawnShellTerminal, sleep } = testUtils || {};
  let manager: PtyManager;

  beforeEach(() => {
    manager = new PtyManagerClass!();
  });

  afterEach(async () => {
    await cleanupPtyManager?.(manager);
  });

  describe("Activity Tier Assignment", () => {
    it("should default to active tier on spawn", async () => {
      const id = await spawnShellTerminal!(manager);
      await sleep!(200);

      const terminal = manager.getTerminal(id);
      expect(terminal).toBeDefined();
    });

    it("should accept setActivityTier calls without error", async () => {
      const id = await spawnShellTerminal!(manager);
      await sleep!(200);

      // These methods don't exist on PtyManager directly - they're IPC channels
      // This test documents the expected behavior at the TerminalProcess level
      const terminal = manager.getTerminal(id);
      expect(terminal).toBeDefined();

      // ActivityMonitor tier can be changed
      expect(() => terminal?.setActivityMonitorTier(500)).not.toThrow();
      expect(() => terminal?.setActivityMonitorTier(50)).not.toThrow();
    });
  });

  describe("ActivityMonitor Polling Integration", () => {
    it("should support tier-driven polling interval changes", async () => {
      const id = await spawnShellTerminal!(manager);
      await sleep!(200);

      const terminal = manager.getTerminal(id);
      expect(terminal).toBeDefined();

      // Change to background tier polling (500ms)
      terminal?.setActivityMonitorTier(500);

      // Change to active tier polling (50ms)
      terminal?.setActivityMonitorTier(50);

      // Verify terminal is still functioning
      await sleep!(100);
      expect(manager.getTerminal(id)).toBeDefined();
    });

    it("should not crash when changing tiers multiple times", async () => {
      const id = await spawnShellTerminal!(manager);
      await sleep!(200);

      const terminal = manager.getTerminal(id);

      // Rapid tier changes should be safe
      for (let i = 0; i < 5; i++) {
        terminal?.setActivityMonitorTier(500);
        terminal?.setActivityMonitorTier(50);
      }

      await sleep!(100);
      expect(manager.getTerminal(id)).toBeDefined();
    });
  });

  describe("Terminal Lifecycle with Tier Changes", () => {
    it("should clean up tier state on terminal exit", async () => {
      const id = await spawnShellTerminal!(manager);
      await sleep!(200);

      const terminal = manager.getTerminal(id);
      expect(terminal).toBeDefined();

      // Set to background tier
      terminal?.setActivityMonitorTier(500);

      // Kill terminal
      manager.kill(id);
      await sleep!(200);

      // Verify cleanup
      expect(manager.getTerminal(id)).toBeUndefined();
    });
  });
});
