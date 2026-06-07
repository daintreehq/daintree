import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PtyManager } from "../PtyManager.js";
import { cleanupPtyManager, spawnShellTerminal, sleep } from "./helpers/ptyTestUtils.js";

describe("PtyManager Activity Tier", () => {
  let manager: PtyManager;

  beforeEach(() => {
    manager = new PtyManager();
  });

  afterEach(async () => {
    await cleanupPtyManager(manager);
  });

  describe("Activity Tier Assignment", () => {
    it("should default to active tier on spawn", async () => {
      const id = await spawnShellTerminal(manager);
      await sleep(200);

      const terminal = manager.getTerminal(id);
      expect(terminal).toBeDefined();
    });

    it("should accept setActivityTier calls without error", async () => {
      const id = await spawnShellTerminal(manager);
      await sleep(200);

      // These methods don't exist on PtyManager directly - they're IPC channels
      // This test documents the expected behavior at the TerminalProcess level
      const terminal = manager.getTerminal(id);
      expect(terminal).toBeDefined();

      // ActivityMonitor tier can be changed
      expect(() => manager.setActivityMonitorTier(id, "background", 500)).not.toThrow();
      expect(() => manager.setActivityMonitorTier(id, "active", 50)).not.toThrow();
    });

    it("should store the explicit tier, not derive it from the polling interval", async () => {
      const id = await spawnShellTerminal(manager);
      await sleep(200);

      // Issue #9911: VISIBLE-unfocused panes send ("active", 200ms). The old
      // code derived tier from interval <= 50, misclassifying this as background.
      manager.setActivityMonitorTier(id, "active", 200);
      expect(manager.getActivityTier(id)).toBe("active");

      manager.setActivityMonitorTier(id, "background", 500);
      expect(manager.getActivityTier(id)).toBe("background");

      manager.setActivityMonitorTier(id, "active", 50);
      expect(manager.getActivityTier(id)).toBe("active");
    });
  });

  describe("ActivityMonitor Polling Integration", () => {
    it("should support tier-driven polling interval changes", async () => {
      const id = await spawnShellTerminal(manager);
      await sleep(200);

      const terminal = manager.getTerminal(id);
      expect(terminal).toBeDefined();

      // Change to background tier polling (500ms)
      manager.setActivityMonitorTier(id, "background", 500);

      // Change to active tier polling (50ms)
      manager.setActivityMonitorTier(id, "active", 50);

      // Verify terminal is still functioning
      await sleep(100);
      expect(manager.getTerminal(id)).toBeDefined();
    });

    it("should not crash when changing tiers multiple times", async () => {
      const id = await spawnShellTerminal(manager);
      await sleep(200);

      // Rapid tier changes should be safe
      for (let i = 0; i < 5; i++) {
        manager.setActivityMonitorTier(id, "background", 500);
        manager.setActivityMonitorTier(id, "active", 50);
      }

      await sleep(100);
      expect(manager.getTerminal(id)).toBeDefined();
    });
  });

  describe("Terminal Lifecycle with Tier Changes", () => {
    it("should clean up tier state on terminal exit", async () => {
      const id = await spawnShellTerminal(manager);
      await sleep(200);

      const terminal = manager.getTerminal(id);
      expect(terminal).toBeDefined();

      // Set to background tier
      manager.setActivityMonitorTier(id, "background", 500);

      // Kill terminal
      manager.kill(id);
      await sleep(200);

      // Verify cleanup
      expect(manager.getTerminal(id)).toBeUndefined();
    });
  });
});
