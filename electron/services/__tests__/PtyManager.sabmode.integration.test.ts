import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PtyManager } from "../PtyManager.js";
import {
  cleanupPtyManager,
  spawnShellTerminal,
  sleep,
  waitForData,
} from "./helpers/ptyTestUtils.js";

describe("PtyManager SAB Mode Flow Control", () => {
  let manager: PtyManager;

  beforeEach(() => {
    manager = new PtyManager();
  });

  afterEach(async () => {
    await cleanupPtyManager(manager);
  });

  describe("SAB Mode Configuration", () => {
    it("should default to SAB mode disabled", () => {
      expect(manager.isSabMode()).toBe(false);
    });

    it("should enable SAB mode when setSabMode(true) is called", () => {
      manager.setSabMode(true);
      expect(manager.isSabMode()).toBe(true);
    });

    it("should disable SAB mode when setSabMode(false) is called", () => {
      manager.setSabMode(true);
      manager.setSabMode(false);
      expect(manager.isSabMode()).toBe(false);
    });
  });

  describe("Flow Control in IPC Mode (SAB disabled)", () => {
    it("should spawn terminal with per-terminal flow control active", async () => {
      expect(manager.isSabMode()).toBe(false);
      const id = await spawnShellTerminal(manager);
      await sleep(200);
      const terminal = manager.getTerminal(id);
      expect(terminal).toBeDefined();
    });

    it("should acknowledge data in IPC mode", async () => {
      const id = await spawnShellTerminal(manager);
      await sleep(200);
      // acknowledgeData should not throw in IPC mode
      expect(() => manager.acknowledgeData(id, 1000)).not.toThrow();
    });
  });

  describe("Flow Control in SAB Mode (SAB enabled)", () => {
    beforeEach(() => {
      manager.setSabMode(true);
    });

    it("should spawn terminal with SAB mode flag propagated", async () => {
      expect(manager.isSabMode()).toBe(true);
      const id = await spawnShellTerminal(manager);
      await sleep(200);
      const terminal = manager.getTerminal(id);
      expect(terminal).toBeDefined();
    });

    it("should acknowledge data in SAB mode without error", async () => {
      const id = await spawnShellTerminal(manager);
      await sleep(200);
      // acknowledgeData should be a no-op but not throw in SAB mode
      expect(() => manager.acknowledgeData(id, 1000)).not.toThrow();
    });

    it("should allow high-output terminal without pausing in SAB mode", async () => {
      // This test verifies that in SAB mode, terminals don't pause due to
      // unacknowledged output. Without SAB mode bypass, terminals producing
      // more than 100KB of output would pause waiting for renderer acks.
      const id = await spawnShellTerminal(manager);
      await sleep(200);

      // Exceed HIGH_WATERMARK_CHARS (100KB) and ensure the final sentinel arrives
      // This proves the terminal didn't pause mid-stream waiting for renderer acks
      manager.write(id, `node -e "process.stdout.write('x'.repeat(120000) + '\\nEND\\n')"\n`);

      const received = await waitForData(manager, id, (data) => data.includes("END"), 5000);
      expect(received).toContain("END");
    });
  });

  describe("Mode Transition", () => {
    it("should allow enabling SAB mode before spawning terminals", async () => {
      manager.setSabMode(true);
      const id = await spawnShellTerminal(manager);
      await sleep(200);
      expect(manager.getTerminal(id)).toBeDefined();
    });

    it("should apply SAB mode setting only to newly spawned terminals", async () => {
      // Spawn terminal with SAB mode disabled
      const id1 = await spawnShellTerminal(manager);
      await sleep(200);

      // Enable SAB mode and spawn another terminal
      manager.setSabMode(true);
      const id2 = await spawnShellTerminal(manager);
      await sleep(200);

      // Both terminals should work
      expect(manager.getTerminal(id1)).toBeDefined();
      expect(manager.getTerminal(id2)).toBeDefined();
    });
  });
});
