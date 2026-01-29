import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "crypto";
import type { PtyManager } from "../PtyManager.js";

let PtyManagerClass: any;
let testUtils: any;

try {
  PtyManagerClass = (await import("../PtyManager.js")).PtyManager;
  testUtils = await import("./helpers/ptyTestUtils.js");
} catch (_error) {
  console.warn("node-pty not available, skipping PTY integration tests");
}

const shouldSkip = !PtyManagerClass;

describe.skipIf(shouldSkip)("PtyManager Integration", () => {
  const {
    cleanupPtyManager,
    waitForData,
    waitForExit,
    spawnEchoTerminal,
    spawnShellTerminal,
    sleep,
    getShellCommand,
  } = testUtils || {};
  let manager: PtyManager;

  beforeEach(() => {
    manager = new PtyManagerClass();
  });

  afterEach(async () => {
    await cleanupPtyManager(manager);
  });

  describe("PTY Lifecycle", () => {
    it("should spawn terminal and receive data", async () => {
      const id = await spawnEchoTerminal(manager, "test-output");

      const data = await waitForData(manager, id, (d: string) => d.includes("test-output"), 3000);

      expect(data).toContain("test-output");
    }, 10000);

    it("should write to terminal and receive echo", async () => {
      const id = await spawnShellTerminal(manager);

      await sleep(500);

      const dataPromise = waitForData(manager, id, (d: string) => d.includes("hello"), 3000);
      manager.write(id, "echo hello\n");

      const data = await dataPromise;
      expect(data).toContain("hello");
    }, 10000);

    it("should handle terminal exit with code 0", async () => {
      const { shell, args } = getShellCommand("exit 0");
      const id = randomUUID();
      manager.spawn(id, {
        cwd: process.cwd(),
        shell,
        args,
        cols: 80,
        rows: 24,
      });

      const exitCode = await waitForExit(manager, id, 3000);

      expect(exitCode).toBe(0);
      expect(manager.getTerminal(id)).toBeUndefined();
    }, 10000);

    it("should handle terminal exit with non-zero code", async () => {
      const { shell, args } = getShellCommand("exit 1");
      const id = randomUUID();
      manager.spawn(id, {
        cwd: process.cwd(),
        shell,
        args,
        cols: 80,
        rows: 24,
      });

      const exitCode = await waitForExit(manager, id, 3000);

      expect(exitCode).toBe(1);
      expect(manager.getTerminal(id)).toBeUndefined();
    }, 10000);

    it("should resize terminal", async () => {
      const id = await spawnShellTerminal(manager);

      await sleep(200);

      manager.resize(id, 100, 30);

      const terminal = manager.getTerminal(id);
      expect(terminal).toBeDefined();
    }, 10000);

    it("should kill terminal", async () => {
      const id = await spawnShellTerminal(manager);

      await sleep(200);

      const exitPromise = waitForExit(manager, id, 3000);
      await manager.kill(id);

      const exitCode = await exitPromise;
      expect(exitCode).toBeGreaterThanOrEqual(0);
      expect(manager.getTerminal(id)).toBeUndefined();
    }, 10000);
  });

  describe("Multiple Terminals", () => {
    it("should handle multiple terminals simultaneously", async () => {
      const ids = await Promise.all([
        spawnEchoTerminal(manager, "term1"),
        spawnEchoTerminal(manager, "term2"),
        spawnEchoTerminal(manager, "term3"),
      ]);

      const dataPromises = [
        waitForData(manager, ids[0], (d: string) => d.includes("term1"), 3000),
        waitForData(manager, ids[1], (d: string) => d.includes("term2"), 3000),
        waitForData(manager, ids[2], (d: string) => d.includes("term3"), 3000),
      ];

      const results = await Promise.all(dataPromises);

      expect(results[0]).toContain("term1");
      expect(results[1]).toContain("term2");
      expect(results[2]).toContain("term3");
    }, 10000);

    it("should handle rapid spawn/kill cycles", async () => {
      const ids: string[] = [];

      for (let i = 0; i < 5; i++) {
        const id = await spawnShellTerminal(manager);
        ids.push(id);
        await sleep(50);
      }

      await sleep(200);

      await Promise.all(ids.map((id) => manager.kill(id)));

      await sleep(500);

      ids.forEach((id) => {
        expect(manager.getTerminal(id)).toBeUndefined();
      });
    }, 15000);

    it("should get all terminals", async () => {
      const id1 = await spawnShellTerminal(manager);
      const id2 = await spawnShellTerminal(manager);

      await sleep(200);

      const terminals = manager.getAll();

      expect(terminals.length).toBeGreaterThanOrEqual(2);
      expect(terminals.some((t) => t.id === id1)).toBe(true);
      expect(terminals.some((t) => t.id === id2)).toBe(true);
    }, 10000);
  });

  describe("Terminal Metadata", () => {
    it("should store terminal type", async () => {
      const id = await spawnShellTerminal(manager, { type: "claude" });

      const terminal = manager.getTerminal(id);

      expect(terminal).toBeDefined();
      expect(terminal?.type).toBe("claude");
    }, 10000);

    it("should store worktree ID", async () => {
      const id = await spawnShellTerminal(manager, { worktreeId: "test-worktree" });

      const terminal = manager.getTerminal(id);

      expect(terminal).toBeDefined();
      expect(terminal?.worktreeId).toBe("test-worktree");
    }, 10000);

    it("should track spawned timestamp", async () => {
      const before = Date.now();
      const id = await spawnShellTerminal(manager);
      const after = Date.now();

      const terminal = manager.getTerminal(id);

      expect(terminal).toBeDefined();
      expect(terminal?.spawnedAt).toBeGreaterThanOrEqual(before);
      expect(terminal?.spawnedAt).toBeLessThanOrEqual(after);
    }, 10000);
  });

  describe("Terminal Snapshot", () => {
    it("should get terminal snapshot", async () => {
      const id = await spawnShellTerminal(manager);

      await sleep(200);
      manager.write(id, "echo snapshot-test\n");
      await waitForData(manager, id, (d: string) => d.includes("snapshot-test"), 3000);
      await sleep(200);

      const snapshot = manager.getTerminalSnapshot(id);

      expect(snapshot).toBeDefined();
      expect(snapshot?.id).toBe(id);
      expect(snapshot?.lines).toBeDefined();
      expect(Array.isArray(snapshot?.lines)).toBe(true);
    }, 10000);

    it("should return undefined for non-existent terminal", () => {
      const snapshot = manager.getTerminalSnapshot("non-existent-id");
      expect(snapshot).toBeNull();
    }, 10000);
  });

  describe("Error Handling", () => {
    it.skip("should throw error for invalid cwd", async () => {
      const id = randomUUID();
      let error: any;

      try {
        manager.spawn(id, {
          cwd: "/non/existent/path",
          cols: 80,
          rows: 24,
        });
      } catch (e) {
        error = e;
      }

      expect(error).toBeDefined();
    }, 10000);

    it("should handle write to killed terminal gracefully", async () => {
      const id = await spawnShellTerminal(manager);

      await sleep(200);
      await manager.kill(id);
      await sleep(200);

      expect(() => manager.write(id, "test")).not.toThrow();
    }, 10000);

    it("should handle resize of killed terminal gracefully", async () => {
      const id = await spawnShellTerminal(manager);

      await sleep(200);
      await manager.kill(id);
      await sleep(200);

      expect(() => manager.resize(id, 100, 30)).not.toThrow();
    }, 10000);
  });

  describe("Cleanup", () => {
    it("should dispose all terminals", async () => {
      await spawnShellTerminal(manager);
      await spawnShellTerminal(manager);
      await spawnShellTerminal(manager);

      await sleep(200);

      manager.dispose();

      await sleep(500);

      const terminals = manager.getAll();
      expect(terminals.length).toBe(0);
    }, 10000);
  });
});
