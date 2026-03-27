/**
 * Tests for AgentAvailabilityStore - Runtime availability tracking for agents.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AgentAvailabilityStore } from "../AgentAvailabilityStore.js";
import { events } from "../events.js";

describe("AgentAvailabilityStore", () => {
  let store: AgentAvailabilityStore;

  beforeEach(() => {
    store = new AgentAvailabilityStore();
    vi.clearAllMocks();
  });

  afterEach(() => {
    store.dispose();
  });

  describe("agent registration", () => {
    it("registers an agent with initial state", () => {
      store.registerAgent("agent-1", "idle");

      expect(store.getState("agent-1")).toBe("idle");
      expect(store.isAvailable("agent-1")).toBe(true);
      expect(store.getConcurrentTaskCount("agent-1")).toBe(0);
    });

    it("registers an agent with default idle state", () => {
      store.registerAgent("agent-1");

      expect(store.getState("agent-1")).toBe("idle");
      expect(store.isAvailable("agent-1")).toBe(true);
    });

    it("does not overwrite existing agent on re-registration", () => {
      store.registerAgent("agent-1", "idle");

      // Simulate a state change
      events.emit("agent:state-changed", {
        agentId: "agent-1",
        state: "working",
        previousState: "idle",
        timestamp: Date.now(),
        trigger: "input",
        confidence: 1.0,
      });

      // Try to re-register
      store.registerAgent("agent-1", "idle");

      // State should still be "working"
      expect(store.getState("agent-1")).toBe("working");
    });

    it("unregisters an agent", () => {
      store.registerAgent("agent-1", "idle");
      store.unregisterAgent("agent-1");

      expect(store.getState("agent-1")).toBeUndefined();
      expect(store.isAvailable("agent-1")).toBe(false);
    });
  });

  describe("availability tracking", () => {
    it("tracks state changes from events", () => {
      store.registerAgent("agent-1", "idle");

      events.emit("agent:state-changed", {
        agentId: "agent-1",
        state: "working",
        previousState: "idle",
        timestamp: Date.now(),
        trigger: "input",
        confidence: 1.0,
      });

      expect(store.getState("agent-1")).toBe("working");
      expect(store.isAvailable("agent-1")).toBe(false);
    });

    it("considers idle state as available", () => {
      store.registerAgent("agent-1");

      events.emit("agent:state-changed", {
        agentId: "agent-1",
        state: "idle",
        previousState: "working",
        timestamp: Date.now(),
        trigger: "output",
        confidence: 1.0,
      });

      expect(store.isAvailable("agent-1")).toBe(true);
    });

    it("considers waiting state as available", () => {
      store.registerAgent("agent-1");

      events.emit("agent:state-changed", {
        agentId: "agent-1",
        state: "waiting",
        previousState: "working",
        timestamp: Date.now(),
        trigger: "output",
        confidence: 1.0,
      });

      expect(store.isAvailable("agent-1")).toBe(true);
    });

    it("considers working state as unavailable", () => {
      store.registerAgent("agent-1", "idle");

      events.emit("agent:state-changed", {
        agentId: "agent-1",
        state: "working",
        previousState: "idle",
        timestamp: Date.now(),
        trigger: "input",
        confidence: 1.0,
      });

      expect(store.isAvailable("agent-1")).toBe(false);
    });

    it("ignores events without agentId", () => {
      store.registerAgent("agent-1", "idle");

      events.emit("agent:state-changed", {
        state: "working",
        previousState: "idle",
        timestamp: Date.now(),
        trigger: "input",
        confidence: 1.0,
      });

      expect(store.getState("agent-1")).toBe("idle");
    });
  });

  describe("concurrent task tracking", () => {
    it("increments concurrent tasks on task:assigned", () => {
      store.registerAgent("agent-1");

      events.emit("task:assigned", {
        taskId: "task-1",
        agentId: "agent-1",
        timestamp: Date.now(),
      });

      expect(store.getConcurrentTaskCount("agent-1")).toBe(1);
    });

    it("decrements concurrent tasks on task:completed", () => {
      store.registerAgent("agent-1");

      events.emit("task:assigned", {
        taskId: "task-1",
        agentId: "agent-1",
        timestamp: Date.now(),
      });

      events.emit("task:completed", {
        taskId: "task-1",
        agentId: "agent-1",
        result: "Success",
        timestamp: Date.now(),
      });

      expect(store.getConcurrentTaskCount("agent-1")).toBe(0);
    });

    it("decrements concurrent tasks on task:failed", () => {
      store.registerAgent("agent-1");

      events.emit("task:assigned", {
        taskId: "task-1",
        agentId: "agent-1",
        timestamp: Date.now(),
      });

      events.emit("task:failed", {
        taskId: "task-1",
        agentId: "agent-1",
        error: "Something went wrong",
        timestamp: Date.now(),
      });

      expect(store.getConcurrentTaskCount("agent-1")).toBe(0);
    });

    it("tracks multiple concurrent tasks", () => {
      store.registerAgent("agent-1");

      events.emit("task:assigned", {
        taskId: "task-1",
        agentId: "agent-1",
        timestamp: Date.now(),
      });

      events.emit("task:assigned", {
        taskId: "task-2",
        agentId: "agent-1",
        timestamp: Date.now(),
      });

      expect(store.getConcurrentTaskCount("agent-1")).toBe(2);

      events.emit("task:completed", {
        taskId: "task-1",
        agentId: "agent-1",
        result: "Done",
        timestamp: Date.now(),
      });

      expect(store.getConcurrentTaskCount("agent-1")).toBe(1);
    });

    it("does not go below zero concurrent tasks", () => {
      store.registerAgent("agent-1");

      events.emit("task:completed", {
        taskId: "task-1",
        agentId: "agent-1",
        result: "Done",
        timestamp: Date.now(),
      });

      expect(store.getConcurrentTaskCount("agent-1")).toBe(0);
    });
  });

  describe("getAgentsByAvailability", () => {
    it("returns all agents with availability info", () => {
      store.registerAgent("agent-1", "idle");
      store.registerAgent("agent-2", "working");

      const agents = store.getAgentsByAvailability();

      expect(agents).toHaveLength(2);

      const agent1 = agents.find((a) => a.agentId === "agent-1");
      expect(agent1).toBeDefined();
      expect(agent1?.available).toBe(true);
      expect(agent1?.state).toBe("idle");

      const agent2 = agents.find((a) => a.agentId === "agent-2");
      expect(agent2).toBeDefined();
      expect(agent2?.available).toBe(false);
      expect(agent2?.state).toBe("working");
    });

    it("returns empty array when no agents registered", () => {
      const agents = store.getAgentsByAvailability();
      expect(agents).toEqual([]);
    });
  });

  describe("getAvailableAgents", () => {
    it("returns only available agents", () => {
      store.registerAgent("agent-1", "idle");
      store.registerAgent("agent-2", "working");
      store.registerAgent("agent-3", "waiting");

      const available = store.getAvailableAgents();

      expect(available).toHaveLength(2);
      expect(available.map((a) => a.agentId).sort()).toEqual(["agent-1", "agent-3"]);
    });
  });

  describe("clear", () => {
    it("clears all tracked state", () => {
      store.registerAgent("agent-1", "idle");
      store.registerAgent("agent-2", "working");

      store.clear();

      expect(store.getAgentsByAvailability()).toEqual([]);
      expect(store.getState("agent-1")).toBeUndefined();
    });
  });

  describe("trash filtering", () => {
    it("excludes trashed agent from getAgentsByAvailability", () => {
      store.registerAgent("agent-1", "working");

      events.emit("agent:spawned", {
        agentId: "agent-1",
        terminalId: "term-1",
        type: "claude",
        timestamp: Date.now(),
      });

      events.emit("terminal:trashed", { id: "term-1", expiresAt: Date.now() + 60000 });

      const agents = store.getAgentsByAvailability();
      expect(agents.find((a) => a.agentId === "agent-1")).toBeUndefined();
    });

    it("re-includes restored agent in getAgentsByAvailability", () => {
      store.registerAgent("agent-1", "working");

      events.emit("agent:spawned", {
        agentId: "agent-1",
        terminalId: "term-1",
        type: "claude",
        timestamp: Date.now(),
      });

      events.emit("terminal:trashed", { id: "term-1", expiresAt: Date.now() + 60000 });
      events.emit("terminal:restored", { id: "term-1" });

      const agents = store.getAgentsByAvailability();
      expect(agents.find((a) => a.agentId === "agent-1")).toBeDefined();
    });

    it("returns 0 active agents when all working agents are trashed", () => {
      store.registerAgent("agent-1", "working");
      store.registerAgent("agent-2", "working");

      events.emit("agent:spawned", {
        agentId: "agent-1",
        terminalId: "term-1",
        type: "claude",
        timestamp: Date.now(),
      });
      events.emit("agent:spawned", {
        agentId: "agent-2",
        terminalId: "term-2",
        type: "claude",
        timestamp: Date.now(),
      });

      events.emit("terminal:trashed", { id: "term-1", expiresAt: Date.now() + 60000 });
      events.emit("terminal:trashed", { id: "term-2", expiresAt: Date.now() + 60000 });

      expect(store.getAgentsByAvailability()).toHaveLength(0);
    });

    it("still shows non-trashed active agents", () => {
      store.registerAgent("agent-1", "working");
      store.registerAgent("agent-2", "working");

      events.emit("agent:spawned", {
        agentId: "agent-1",
        terminalId: "term-1",
        type: "claude",
        timestamp: Date.now(),
      });
      events.emit("agent:spawned", {
        agentId: "agent-2",
        terminalId: "term-2",
        type: "claude",
        timestamp: Date.now(),
      });

      events.emit("terminal:trashed", { id: "term-1", expiresAt: Date.now() + 60000 });

      const agents = store.getAgentsByAvailability();
      expect(agents).toHaveLength(1);
      expect(agents[0].agentId).toBe("agent-2");
    });

    it("handles trash before spawn (race condition)", () => {
      store.registerAgent("agent-1", "working");

      events.emit("terminal:trashed", { id: "term-1", expiresAt: Date.now() + 60000 });

      events.emit("agent:spawned", {
        agentId: "agent-1",
        terminalId: "term-1",
        type: "claude",
        timestamp: Date.now(),
      });

      expect(store.getAgentsByAvailability().find((a) => a.agentId === "agent-1")).toBeUndefined();
    });

    it("cleans up trash state on unregisterAgent", () => {
      store.registerAgent("agent-1", "working");

      events.emit("agent:spawned", {
        agentId: "agent-1",
        terminalId: "term-1",
        type: "claude",
        timestamp: Date.now(),
      });

      events.emit("terminal:trashed", { id: "term-1", expiresAt: Date.now() + 60000 });

      store.unregisterAgent("agent-1");

      // Re-register with same agentId — should not be trashed
      store.registerAgent("agent-1", "idle");
      expect(store.getAgentsByAvailability().find((a) => a.agentId === "agent-1")).toBeDefined();
    });

    it("clears all trash state on clear()", () => {
      store.registerAgent("agent-1", "working");

      events.emit("agent:spawned", {
        agentId: "agent-1",
        terminalId: "term-1",
        type: "claude",
        timestamp: Date.now(),
      });

      events.emit("terminal:trashed", { id: "term-1", expiresAt: Date.now() + 60000 });

      store.clear();

      // Re-register — should not be trashed
      store.registerAgent("agent-1", "idle");
      events.emit("agent:spawned", {
        agentId: "agent-1",
        terminalId: "term-1",
        type: "claude",
        timestamp: Date.now(),
      });

      expect(store.getAgentsByAvailability().find((a) => a.agentId === "agent-1")).toBeDefined();
    });

    it("excludes trashed agents from getAvailableAgents too", () => {
      store.registerAgent("agent-1", "idle");

      events.emit("agent:spawned", {
        agentId: "agent-1",
        terminalId: "term-1",
        type: "claude",
        timestamp: Date.now(),
      });

      events.emit("terminal:trashed", { id: "term-1", expiresAt: Date.now() + 60000 });

      expect(store.getAvailableAgents()).toHaveLength(0);
    });
  });

  describe("dispose", () => {
    it("stops listening to events after dispose", () => {
      store.registerAgent("agent-1", "idle");
      store.dispose();

      // Emit event after dispose
      events.emit("agent:state-changed", {
        agentId: "agent-1",
        state: "working",
        previousState: "idle",
        timestamp: Date.now(),
        trigger: "input",
        confidence: 1.0,
      });

      // State should not have changed (or should not exist due to clear)
      expect(store.getState("agent-1")).toBeUndefined();
    });
  });
});
