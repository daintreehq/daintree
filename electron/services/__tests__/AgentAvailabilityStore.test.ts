/**
 * Tests for AgentAvailabilityStore - Runtime availability tracking for agents.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  AgentAvailabilityStore,
  MAX_CLOSED_TERMINALS as CLOSED_TERMINAL_CAPACITY,
} from "../AgentAvailabilityStore.js";
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

  describe("exit metadata tracking", () => {
    it("caches exitCode from a completed transition", () => {
      store.registerAgent("agent-1", "working");

      events.emit("agent:state-changed", {
        agentId: "agent-1",
        state: "completed",
        previousState: "working",
        timestamp: Date.now(),
        trigger: "exit",
        confidence: 1.0,
        exitCode: 0,
      });

      expect(store.getExitCode("agent-1")).toBe(0);
    });

    it("caches a non-zero exitCode from an exited transition", () => {
      store.registerAgent("agent-1", "working");

      events.emit("agent:state-changed", {
        agentId: "agent-1",
        state: "exited",
        previousState: "working",
        timestamp: Date.now(),
        trigger: "exit",
        confidence: 1.0,
        exitCode: 1,
      });

      expect(store.getExitCode("agent-1")).toBe(1);
    });

    it("caches a null exitCode plus exitSignal for a signal-terminated exit", () => {
      store.registerAgent("agent-1", "working");

      events.emit("agent:state-changed", {
        agentId: "agent-1",
        state: "exited",
        previousState: "working",
        timestamp: Date.now(),
        trigger: "exit",
        confidence: 1.0,
        exitCode: null,
        exitSignal: 9,
      });

      expect(store.getExitCode("agent-1")).toBeNull();
      expect(store.getExitSignal("agent-1")).toBe(9);
    });

    it("does not record exit metadata for non-terminal transitions", () => {
      store.registerAgent("agent-1", "idle");

      events.emit("agent:state-changed", {
        agentId: "agent-1",
        state: "working",
        previousState: "idle",
        timestamp: Date.now(),
        trigger: "input",
        confidence: 1.0,
      });

      expect(store.getExitCode("agent-1")).toBeUndefined();
      expect(store.getExitSignal("agent-1")).toBeUndefined();
    });

    it("captures spawnedAt from agent:spawned", () => {
      events.emit("agent:spawned", {
        agentId: "agent-1",
        terminalId: "term-1",
        timestamp: 1234,
      });

      expect(store.getSpawnedAt("agent-1")).toBe(1234);
    });

    it("clears stale exit metadata when the agent respawns under the same id", () => {
      store.registerAgent("agent-1", "working");
      events.emit("agent:state-changed", {
        agentId: "agent-1",
        state: "exited",
        previousState: "working",
        timestamp: Date.now(),
        trigger: "exit",
        confidence: 1.0,
        exitCode: 1,
      });
      expect(store.getExitCode("agent-1")).toBe(1);

      // A new session under the same agentId must not inherit the old exit code.
      events.emit("agent:spawned", {
        agentId: "agent-1",
        terminalId: "term-1",
        timestamp: Date.now(),
      });

      expect(store.getExitCode("agent-1")).toBeUndefined();
    });

    it("clears exit metadata on unregisterAgent", () => {
      store.registerAgent("agent-1", "working");
      events.emit("agent:state-changed", {
        agentId: "agent-1",
        state: "exited",
        previousState: "working",
        timestamp: Date.now(),
        trigger: "exit",
        confidence: 1.0,
        exitCode: 7,
      });

      store.unregisterAgent("agent-1");

      expect(store.getExitCode("agent-1")).toBeUndefined();
      expect(store.getSpawnedAt("agent-1")).toBeUndefined();
    });
  });

  describe("respawn state reset (#10816)", () => {
    it("resets a stale 'waiting' state to 'working' on respawn", () => {
      store.registerAgent("agent-1", "working");
      events.emit("agent:state-changed", {
        agentId: "agent-1",
        state: "waiting",
        previousState: "working",
        timestamp: Date.now(),
        trigger: "output",
        confidence: 1.0,
        waitingReason: "prompt",
      });
      expect(store.getState("agent-1")).toBe("waiting");
      expect(store.getWaitingReason("agent-1")).toBe("prompt");

      // A fresh spawn under the same agentId must not inherit "waiting"; it
      // would otherwise let waitUntilIdle settle as already-idle before the new
      // session's exit event arrives.
      events.emit("agent:spawned", {
        agentId: "agent-1",
        terminalId: "term-1",
        timestamp: Date.now(),
      });

      expect(store.getState("agent-1")).toBe("working");
      expect(store.getWaitingReason("agent-1")).toBeUndefined();
      expect(store.isAvailable("agent-1")).toBe(false);
    });

    it("excludes a freshly respawned agent from getAvailableAgents", () => {
      store.registerAgent("agent-1", "waiting");
      events.emit("agent:spawned", {
        agentId: "agent-1",
        terminalId: "term-1",
        timestamp: Date.now(),
      });

      expect(store.getAvailableAgents().find((a) => a.agentId === "agent-1")).toBeUndefined();
    });

    it("clears a stale 'exited' state on respawn", () => {
      store.registerAgent("agent-1", "working");
      events.emit("agent:state-changed", {
        agentId: "agent-1",
        state: "exited",
        previousState: "working",
        timestamp: Date.now(),
        trigger: "exit",
        confidence: 1.0,
        exitCode: 1,
      });
      expect(store.getState("agent-1")).toBe("exited");

      events.emit("agent:spawned", {
        agentId: "agent-1",
        terminalId: "term-1",
        timestamp: Date.now(),
      });

      expect(store.getState("agent-1")).toBe("working");
      expect(store.getExitCode("agent-1")).toBeUndefined();
    });

    it("records the spawn timestamp as the lastStateChange on respawn", () => {
      store.registerAgent("agent-1", "waiting");
      events.emit("agent:spawned", {
        agentId: "agent-1",
        terminalId: "term-1",
        timestamp: 9999,
      });

      expect(store.getLastStateChange("agent-1")).toBe(9999);
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
        timestamp: Date.now(),
      });
      events.emit("agent:spawned", {
        agentId: "agent-2",
        terminalId: "term-2",
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
        timestamp: Date.now(),
      });
      events.emit("agent:spawned", {
        agentId: "agent-2",
        terminalId: "term-2",
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
        timestamp: Date.now(),
      });

      expect(store.getAgentsByAvailability().find((a) => a.agentId === "agent-1")).toBeUndefined();
    });

    it("cleans up trash state on unregisterAgent", () => {
      store.registerAgent("agent-1", "working");

      events.emit("agent:spawned", {
        agentId: "agent-1",
        terminalId: "term-1",
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
        timestamp: Date.now(),
      });

      events.emit("terminal:trashed", { id: "term-1", expiresAt: Date.now() + 60000 });

      store.clear();

      // Re-register — should not be trashed
      store.registerAgent("agent-1", "idle");
      events.emit("agent:spawned", {
        agentId: "agent-1",
        terminalId: "term-1",
        timestamp: Date.now(),
      });

      expect(store.getAgentsByAvailability().find((a) => a.agentId === "agent-1")).toBeDefined();
    });

    it("excludes trashed agents from getAvailableAgents too", () => {
      store.registerAgent("agent-1", "idle");

      events.emit("agent:spawned", {
        agentId: "agent-1",
        terminalId: "term-1",
        timestamp: Date.now(),
      });

      events.emit("terminal:trashed", { id: "term-1", expiresAt: Date.now() + 60000 });

      expect(store.getAvailableAgents()).toHaveLength(0);
    });
  });

  describe("help terminal tracking", () => {
    it("isHelpTerminal returns false for unknown terminal", () => {
      expect(store.isHelpTerminal("unknown-term")).toBe(false);
    });

    it("isHelpTerminal returns true after markAsHelp", () => {
      store.markAsHelp("term-help");
      expect(store.isHelpTerminal("term-help")).toBe(true);
    });

    it("isHelpTerminal returns false after unmarkAsHelp", () => {
      store.markAsHelp("term-help");
      store.unmarkAsHelp("term-help");
      expect(store.isHelpTerminal("term-help")).toBe(false);
    });

    it("excludes help agents from getAgentsByAvailability", () => {
      store.registerAgent("agent-help", "idle");
      events.emit("agent:spawned", {
        agentId: "agent-help",
        terminalId: "term-help",
        timestamp: Date.now(),
      });
      store.markAsHelp("term-help");

      expect(
        store.getAgentsByAvailability().find((a) => a.agentId === "agent-help")
      ).toBeUndefined();
    });

    it("markAsHelp before agent:spawned still marks agent when spawn arrives", () => {
      store.registerAgent("agent-help", "idle");
      store.markAsHelp("term-help");

      events.emit("agent:spawned", {
        agentId: "agent-help",
        terminalId: "term-help",
        timestamp: Date.now(),
      });

      expect(store.isHelpTerminal("term-help")).toBe(true);
      expect(
        store.getAgentsByAvailability().find((a) => a.agentId === "agent-help")
      ).toBeUndefined();
    });

    it("unregisterAgent clears help membership", () => {
      store.registerAgent("agent-help", "idle");
      events.emit("agent:spawned", {
        agentId: "agent-help",
        terminalId: "term-help",
        timestamp: Date.now(),
      });
      store.markAsHelp("term-help");
      store.unregisterAgent("agent-help");

      expect(store.isHelpTerminal("term-help")).toBe(false);
    });
  });

  // #12339 — a killed terminal used to keep its mapping forever, so
  // waitUntilIdle read the kill's `idle` state and could not tell a closed
  // panel from an agent at rest.
  describe("terminal-scoped release on agent:killed", () => {
    const spawn = (agentId: string, terminalId: string) => {
      events.emit("agent:spawned", { agentId, terminalId, timestamp: Date.now() });
    };

    it("drops the terminal mapping when its agent is killed", () => {
      spawn("claude", "term-1");
      expect(store.getAgentIdForTerminal("term-1")).toBe("claude");

      events.emit("agent:killed", {
        agentId: "claude",
        terminalId: "term-1",
        timestamp: Date.now(),
      });

      expect(store.getAgentIdForTerminal("term-1")).toBeUndefined();
      expect(store.isTerminalClosed("term-1")).toBe(true);
    });

    it("reports an id it has never seen as not closed", () => {
      expect(store.isTerminalClosed("never-existed")).toBe(false);
    });

    // The reason this is not `unregisterAgent`: agent ids name the agent type,
    // so two panels running "claude" share one id.
    it("killing one terminal leaves a live sibling of the same agent type mapped", () => {
      spawn("claude", "term-old");
      spawn("claude", "term-new");

      // Model the real kill of term-old, which emits its idle transition first
      // and only then the kill notice.
      events.emit("agent:state-changed", {
        agentId: "claude",
        terminalId: "term-old",
        state: "idle",
        previousState: "working",
        timestamp: Date.now(),
        trigger: "exit",
        confidence: 1,
      });
      events.emit("agent:killed", {
        agentId: "claude",
        terminalId: "term-old",
        timestamp: Date.now(),
      });

      // Only the killed terminal is released. The live sibling keeps BOTH
      // directions of the mapping — deleting the reverse entry unconditionally
      // would un-map term-new here, which is why this is not `unregisterAgent`.
      expect(store.getAgentIdForTerminal("term-old")).toBeUndefined();
      expect(store.getAgentIdForTerminal("term-new")).toBe("claude");
      expect(store.getTerminalIdForAgent("claude")).toBe("term-new");
      expect(store.isTerminalClosed("term-old")).toBe(true);
      expect(store.isTerminalClosed("term-new")).toBe(false);
      // Deliberately NOT asserted: `agentStates` is keyed by agent id, so
      // term-old's idle overwrote the state term-new shares. That conflation
      // predates #12339 and this change neither fixes nor worsens it — the
      // per-terminal mappings above are what it makes correct.
    });

    it("clears the reverse mapping when the killed terminal still owns it", () => {
      spawn("claude", "term-1");

      events.emit("agent:killed", {
        agentId: "claude",
        terminalId: "term-1",
        timestamp: Date.now(),
      });

      expect(store.getTerminalIdForAgent("claude")).toBeUndefined();
    });

    it("ignores an agent:killed with no terminalId", () => {
      spawn("claude", "term-1");

      events.emit("agent:killed", { agentId: "claude", timestamp: Date.now() });

      expect(store.getAgentIdForTerminal("term-1")).toBe("claude");
    });

    it("a respawn under the same terminal id clears the closed mark", () => {
      spawn("claude", "term-1");
      events.emit("agent:killed", {
        agentId: "claude",
        terminalId: "term-1",
        timestamp: Date.now(),
      });
      expect(store.isTerminalClosed("term-1")).toBe(true);

      spawn("claude", "term-1");

      expect(store.isTerminalClosed("term-1")).toBe(false);
      expect(store.getAgentIdForTerminal("term-1")).toBe("claude");
    });

    it("marks a terminal closed even when no mapping was ever recorded", () => {
      events.emit("agent:killed", {
        agentId: "claude",
        terminalId: "unmapped",
        timestamp: Date.now(),
      });

      expect(store.isTerminalClosed("unmapped")).toBe(true);
    });

    const close = (terminalId: string) =>
      events.emit("agent:killed", { agentId: "claude", terminalId, timestamp: Date.now() });

    it("remembers a full capacity of closed terminals", () => {
      for (let i = 0; i < CLOSED_TERMINAL_CAPACITY; i += 1) close(`term-${i}`);

      // Every one still answers "closed" — asserting the boundary rather than
      // just "the newest survived", which would hold for a capacity of one.
      const forgotten = Array.from(
        { length: CLOSED_TERMINAL_CAPACITY },
        (_, i) => `term-${i}`
      ).filter((id) => !store.isTerminalClosed(id));
      expect(forgotten).toEqual([]);
    });

    it("evicts exactly the oldest entry when one more closes", () => {
      for (let i = 0; i < CLOSED_TERMINAL_CAPACITY; i += 1) close(`term-${i}`);

      close("term-overflow");

      // Only the single oldest is dropped, and eviction downgrades it to
      // "not closed" (which the handler reports as `unknown`) — never back to
      // tracked, since no mapping is recreated.
      expect(store.isTerminalClosed("term-0")).toBe(false);
      expect(store.getAgentIdForTerminal("term-0")).toBeUndefined();
      expect(store.isTerminalClosed("term-1")).toBe(true);
      expect(store.isTerminalClosed("term-overflow")).toBe(true);
    });

    it("re-closing an entry refreshes its recency so the next-oldest ages out", () => {
      for (let i = 0; i < CLOSED_TERMINAL_CAPACITY; i += 1) close(`term-${i}`);

      close("term-0");
      close("term-overflow");

      // term-0 was refreshed, so term-1 is now the oldest and goes instead.
      expect(store.isTerminalClosed("term-0")).toBe(true);
      expect(store.isTerminalClosed("term-1")).toBe(false);
    });

    it("clear() forgets closed terminals", () => {
      events.emit("agent:killed", {
        agentId: "claude",
        terminalId: "term-1",
        timestamp: Date.now(),
      });
      store.clear();

      expect(store.isTerminalClosed("term-1")).toBe(false);
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
