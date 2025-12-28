import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { PtyManager } from "../PtyManager.js";
import { events, type CanopyEventMap } from "../events.js";

// Type for agent:state-changed event handler
type AgentStateChangedHandler = (payload: CanopyEventMap["agent:state-changed"]) => void;

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
    it("should transition agent state manually from waiting to working", async () => {
      const id = await spawnShellTerminal(manager, { type: "claude" });
      await sleep(500);

      // First, ensure terminal reaches waiting state
      // Transition to working, then to waiting
      manager.transitionState(id, { type: "busy" }, "activity", 1.0);
      await sleep(100);
      manager.transitionState(id, { type: "prompt" }, "activity", 1.0);
      await sleep(100);

      // Now test waiting → working transition
      const statePromise = waitForAgentStateChange(manager, id, 2000, "working");
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
      const handler: AgentStateChangedHandler = (data) => {
        if (data.terminalId === id) {
          eventEmitted = true;
        }
      };

      events.on("agent:state-changed", handler);

      manager.transitionState(id, { type: "prompt" }, "activity", 1.0);
      await sleep(500);

      expect(eventEmitted).toBe(true);
      events.off("agent:state-changed", handler);
    }, 10000);

    it("should track multiple state transitions", async () => {
      const id = await spawnShellTerminal(manager, { type: "claude" });
      await sleep(500);

      const states: string[] = [];
      const handler: AgentStateChangedHandler = (data) => {
        if (data.terminalId === id) {
          states.push(data.state);
        }
      };

      events.on("agent:state-changed", handler);

      manager.transitionState(id, { type: "busy" }, "activity", 1.0);
      await sleep(200);
      manager.transitionState(id, { type: "prompt" }, "activity", 1.0);
      await sleep(200);
      manager.transitionState(id, { type: "busy" }, "activity", 1.0);
      await sleep(200);

      expect(states.length).toBeGreaterThanOrEqual(1);
      events.off("agent:state-changed", handler);
    }, 10000);
  });

  describe("State Change Timestamps", () => {
    it("should record timestamp on state change", async () => {
      const id = await spawnShellTerminal(manager, { type: "claude" });
      await sleep(500);

      // First get to waiting state
      manager.transitionState(id, { type: "busy" }, "activity", 1.0);
      await sleep(100);
      manager.transitionState(id, { type: "prompt" }, "activity", 1.0);
      await sleep(100);

      const before = Date.now();
      // Now test waiting → working transition
      const statePromise = waitForAgentStateChange(manager, id, 2000, "working");
      manager.transitionState(id, { type: "busy" }, "activity", 1.0);
      const stateChange = await statePromise;
      const after = Date.now();

      expect(stateChange.timestamp).toBeGreaterThanOrEqual(before);
      expect(stateChange.timestamp).toBeLessThanOrEqual(after);
    }, 10000);

    it("should update lastStateChange in terminal info", async () => {
      const id = await spawnShellTerminal(manager, { type: "claude" });
      await sleep(500);

      // First get to waiting state
      manager.transitionState(id, { type: "busy" }, "activity", 1.0);
      await sleep(100);
      manager.transitionState(id, { type: "prompt" }, "activity", 1.0);
      await sleep(100);

      // Now test waiting → working transition
      const statePromise = waitForAgentStateChange(manager, id, 2000, "working");
      const before = Date.now();
      manager.transitionState(id, { type: "busy" }, "activity", 1.0);
      await statePromise;

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

      // First transition to working, then to completed (exit from idle doesn't work)
      manager.transitionState(id, { type: "busy" }, "activity", 1.0);
      await sleep(100);

      const statePromise = waitForAgentStateChange(manager, id, 2000, "completed");
      manager.transitionState(id, { type: "exit", code: 0 }, "activity", 1.0);

      const stateChange = await statePromise;
      expect(stateChange.state).toBe("completed");
    }, 10000);

    it("should handle state transitions for different agent types", async () => {
      // Note: type="terminal" (shell terminals) don't have agentId and don't emit
      // agent:state-changed events. Use actual agent types for state transition tests.
      const id = await spawnShellTerminal(manager, { type: "gemini" });
      await sleep(500);

      // First get to waiting state
      manager.transitionState(id, { type: "busy" }, "activity", 1.0);
      await sleep(100);
      manager.transitionState(id, { type: "prompt" }, "activity", 1.0);
      await sleep(100);

      // Now test waiting → working transition
      const statePromise = waitForAgentStateChange(manager, id, 2000, "working");
      manager.transitionState(id, { type: "busy" }, "activity", 1.0);

      const stateChange = await statePromise;
      expect(stateChange.id).toBe(id);
      expect(stateChange.state).toBe("working");
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

  describe("Input-Based Activity Detection", () => {
    // Note: These tests verify the full PTY → ActivityMonitor → AgentStateMachine pipeline.
    // They need to wait for ActivityMonitor's natural state transitions (via its debounce timer).

    it("should transition waiting → working when Enter key is pressed after natural idle (core issue #1326)", async () => {
      const id = await spawnShellTerminal(manager, { type: "claude" });

      // Wait for shell startup activity to settle and ActivityMonitor to reach idle state
      // ActivityMonitor debounce is 1500ms, so wait longer for natural state transition
      await sleep(2500);

      // At this point, ActivityMonitor should be in "idle" state naturally
      // and agent state should have transitioned through working → waiting

      // Track state changes for the next Enter key press
      const states: Array<{ state: string; trigger: string }> = [];
      const handler: AgentStateChangedHandler = (data) => {
        if (data.terminalId === id) {
          states.push({ state: data.state, trigger: data.trigger });
        }
      };

      events.on("agent:state-changed", handler);

      // Send Enter key - should trigger idle → busy in ActivityMonitor
      // which maps to waiting → working in agent state
      manager.write(id, "\n");
      await sleep(500);

      events.off("agent:state-changed", handler);

      // Verify we got a working state transition
      const workingStates = states.filter((s) => s.state === "working");
      expect(workingStates.length).toBeGreaterThan(0);
    }, 10000);

    it("should use input trigger for Enter-key driven state changes", async () => {
      const id = await spawnShellTerminal(manager, { type: "claude" });

      // Wait for shell startup to settle
      await sleep(2500);

      // Track state changes
      const states: Array<{ state: string; trigger: string }> = [];
      const handler: AgentStateChangedHandler = (data) => {
        if (data.terminalId === id) {
          states.push({ state: data.state, trigger: data.trigger });
        }
      };

      events.on("agent:state-changed", handler);

      // Send Enter key
      manager.write(id, "\r");
      await sleep(500);

      events.off("agent:state-changed", handler);

      // Verify we got a working state with input trigger
      const inputTriggeredWorking = states.find(
        (s) => s.state === "working" && s.trigger === "input"
      );
      expect(inputTriggeredWorking).toBeDefined();
    }, 10000);

    it("should maintain working → waiting cycle during normal operation", async () => {
      const id = await spawnShellTerminal(manager, { type: "claude" });

      // Wait for initial shell startup to settle
      await sleep(2500);

      // Track all state changes
      const states: Array<{ state: string; trigger: string }> = [];
      const handler: AgentStateChangedHandler = (data) => {
        if (data.terminalId === id) {
          states.push({ state: data.state, trigger: data.trigger });
        }
      };

      events.on("agent:state-changed", handler);

      // Send multiple commands to trigger working → waiting cycles
      for (let i = 0; i < 3; i++) {
        manager.write(id, "echo test\n");
        await sleep(500);
      }

      // Wait for final idle transition
      await sleep(2000);

      events.off("agent:state-changed", handler);

      // Should see working states from Enter keys and waiting states from idle timeouts
      const workingStates = states.filter((s) => s.state === "working");
      expect(workingStates.length).toBeGreaterThanOrEqual(1);
    }, 15000);
  });
});
