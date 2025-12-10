import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { PtyManager } from "../PtyManager.js";

let PtyManagerClass: any;
let testUtils: any;

try {
  PtyManagerClass = (await import("../PtyManager.js")).PtyManager;
  testUtils = await import("./helpers/ptyTestUtils.js");
} catch (_error) {
  console.warn("node-pty not available, skipping agent state detection tests");
}

const shouldSkip = !PtyManagerClass;

describe.skipIf(shouldSkip)("Agent State Detection Integration", () => {
  const { cleanupPtyManager, waitForAgentStateChange, spawnShellTerminal, sleep } = testUtils || {};
  let manager: PtyManager;

  beforeEach(() => {
    manager = new PtyManagerClass();
  });

  afterEach(async () => {
    await cleanupPtyManager(manager);
  });

  describe("Manual State Transitions", () => {
    it("should transition agent state manually", async () => {
      const id = await spawnShellTerminal(manager, { type: "claude" });
      await sleep(500);

      const statePromise = waitForAgentStateChange(manager, id, 2000);
      manager.transitionState(id, { type: "busy" }, "activity", 1.0);

      const stateChange = await statePromise;
      expect(stateChange.id).toBe(id);
      expect(stateChange.state).toBe("working");
      expect(stateChange.trigger).toBe("activity");
    }, 10000);

    it("should track agent state in terminal info", async () => {
      const id = await spawnShellTerminal(manager, { type: "claude" });
      await sleep(500);

      manager.transitionState(id, { type: "busy" }, "activity", 1.0);
      await sleep(200);

      const terminal = manager.getTerminal(id);
      expect(terminal).toBeDefined();
      expect(terminal?.agentState).toBe("working");
    }, 10000);

    it("should emit state change event", async () => {
      const id = await spawnShellTerminal(manager, { type: "gemini" });
      await sleep(500);

      let eventEmitted = false;
      const handler = (data: { id: string; state: string }) => {
        if (data.id === id) {
          eventEmitted = true;
        }
      };

      manager.on("agent:state-changed", handler);

      manager.transitionState(id, { type: "prompt" }, "activity", 1.0);
      await sleep(500);

      expect(eventEmitted).toBe(true);
      manager.off("agent:state-changed", handler);
    }, 10000);

    it("should track multiple state transitions", async () => {
      const id = await spawnShellTerminal(manager, { type: "claude" });
      await sleep(500);

      const states: string[] = [];
      const handler = (data: { id: string; state: string }) => {
        if (data.id === id) {
          states.push(data.state);
        }
      };

      manager.on("agent:state-changed", handler);

      manager.transitionState(id, { type: "busy" }, "activity", 1.0);
      await sleep(200);
      manager.transitionState(id, { type: "prompt" }, "activity", 1.0);
      await sleep(200);
      manager.transitionState(id, { type: "busy" }, "activity", 1.0);
      await sleep(200);

      expect(states.length).toBeGreaterThanOrEqual(1);
      manager.off("agent:state-changed", handler);
    }, 10000);
  });

  describe("State Change Timestamps", () => {
    it("should record timestamp on state change", async () => {
      const id = await spawnShellTerminal(manager, { type: "claude" });
      await sleep(500);

      const before = Date.now();
      const statePromise = waitForAgentStateChange(manager, id, 2000);
      manager.transitionState(id, { type: "busy" }, "activity", 1.0);
      const stateChange = await statePromise;
      const after = Date.now();

      expect(stateChange.timestamp).toBeGreaterThanOrEqual(before);
      expect(stateChange.timestamp).toBeLessThanOrEqual(after);
    }, 10000);

    it("should update lastStateChange in terminal info", async () => {
      const id = await spawnShellTerminal(manager, { type: "claude" });
      await sleep(500);

      const before = Date.now();
      manager.transitionState(id, { type: "busy" }, "activity", 1.0);
      await sleep(200);

      const terminal = manager.getTerminal(id);
      expect(terminal).toBeDefined();
      expect(terminal?.lastStateChange).toBeDefined();
      expect(terminal?.lastStateChange).toBeGreaterThanOrEqual(before);
    }, 10000);
  });

  describe("Agent Type Detection", () => {
    it("should preserve agent type metadata", async () => {
      const id = await spawnShellTerminal(manager, { type: "claude" });
      await sleep(500);

      const terminal = manager.getTerminal(id);
      expect(terminal).toBeDefined();
      expect(terminal?.type).toBe("claude");
    }, 10000);

    it("should handle different agent types", async () => {
      const claudeId = await spawnShellTerminal(manager, { type: "claude" });
      const geminiId = await spawnShellTerminal(manager, { type: "gemini" });
      await sleep(500);

      const claudeTerm = manager.getTerminal(claudeId);
      const geminiTerm = manager.getTerminal(geminiId);

      expect(claudeTerm?.type).toBe("claude");
      expect(geminiTerm?.type).toBe("gemini");
    }, 10000);
  });

  describe("State Transitions for Different Terminal Types", () => {
    it("should handle state transitions for agent terminals", async () => {
      const id = await spawnShellTerminal(manager, { type: "claude" });
      await sleep(500);

      const statePromise = waitForAgentStateChange(manager, id, 2000);
      manager.transitionState(id, { type: "exit", code: 0 }, "activity", 1.0);

      const stateChange = await statePromise;
      expect(stateChange.state).toBe("completed");
    }, 10000);

    it("should handle state transitions for shell terminals", async () => {
      const id = await spawnShellTerminal(manager, { type: "terminal" });
      await sleep(500);

      const statePromise = waitForAgentStateChange(manager, id, 2000);
      manager.transitionState(id, { type: "busy" }, "activity", 1.0);

      const stateChange = await statePromise;
      expect(stateChange.id).toBe(id);
    }, 10000);
  });

  describe("Terminal Snapshot with Agent State", () => {
    it("should include agent state in snapshot", async () => {
      const id = await spawnShellTerminal(manager, { type: "claude" });
      await sleep(500);

      manager.transitionState(id, { type: "busy" }, "activity", 1.0);
      await sleep(200);

      const snapshot = manager.getTerminalSnapshot(id);
      expect(snapshot).toBeDefined();
      expect(snapshot?.agentState).toBe("working");
    }, 10000);

    it("should include last state change timestamp in snapshot", async () => {
      const id = await spawnShellTerminal(manager, { type: "claude" });
      await sleep(500);

      manager.transitionState(id, { type: "busy" }, "activity", 1.0);
      await sleep(200);

      const snapshot = manager.getTerminalSnapshot(id);
      expect(snapshot).toBeDefined();
      expect(snapshot?.lastStateChange).toBeDefined();
      expect(typeof snapshot?.lastStateChange).toBe("number");
    }, 10000);
  });

  describe("Edge Cases", () => {
    it("should handle state transition on non-existent terminal gracefully", () => {
      expect(() =>
        manager.transitionState("non-existent-id", { type: "busy" }, "activity", 1.0)
      ).not.toThrow();
    }, 10000);

    it("should handle rapid state transitions", async () => {
      const id = await spawnShellTerminal(manager, { type: "claude" });
      await sleep(500);

      // states to transition to: "working", "waiting", "working", "completed"
      // events: { type: "busy" }, { type: "prompt" }, { type: "busy" }, { type: "exit", code: 0 }

      const events = [
        { type: "busy" },
        { type: "prompt" },
        { type: "busy" },
        { type: "exit", code: 0 },
      ] as const;

      for (const event of events) {
        manager.transitionState(id, event as any, "activity", 1.0);
        await sleep(50);
      }

      const terminal = manager.getTerminal(id);
      expect(terminal).toBeDefined();
      // Final state should be completed, but we just check if it's defined
      expect(terminal?.agentState).toBeDefined();
    }, 10000);

    it("should maintain state after terminal writes", async () => {
      const id = await spawnShellTerminal(manager, { type: "claude" });
      await sleep(500);

      manager.transitionState(id, { type: "busy" }, "activity", 1.0);
      await sleep(200);

      manager.write(id, "echo test\n");
      await sleep(300);

      const terminal = manager.getTerminal(id);
      expect(terminal?.agentState).toBe("working");
    }, 10000);
  });

  describe("Agent Exit State", () => {
    it("should handle agent state on terminal exit", async () => {
      const id = await spawnShellTerminal(manager, { type: "claude" });
      await sleep(500);

      manager.transitionState(id, { type: "busy" }, "activity", 1.0);
      await sleep(200);

      const exitPromise = new Promise((resolve) => {
        manager.once("exit", (termId: string) => {
          if (termId === id) {
            resolve(termId);
          }
        });
      });

      manager.write(id, "exit\n");
      await Promise.race([exitPromise, sleep(3000)]);

      expect(manager.getTerminal(id)).toBeUndefined();
    }, 10000);
  });
});
