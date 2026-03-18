import { describe, it, expect } from "vitest";
import {
  calculateStateChange,
  createTerminalState,
  pruneSeenArtifacts,
  type AgentEvent,
  type StateChangeResult,
} from "../WorkerAgentStateService.js";
import type { AgentState } from "../../../shared/types/agent.js";

/**
 * Helper to test state transitions through the public calculateStateChange API.
 * Returns the new state, or the current state if no transition occurred.
 */
function calcState(current: AgentState, event: AgentEvent): AgentState {
  const state = createTerminalState("t1", "agent1");
  state.agentState = current;
  return calculateStateChange(state, event)?.state ?? current;
}

describe("WorkerAgentStateService", () => {
  describe("nextAgentState (via calculateStateChange)", () => {
    describe("start event", () => {
      it("should transition idle → working on start", () => {
        expect(calcState("idle", { type: "start" })).toBe("working");
      });

      it("should not transition from other states on start", () => {
        expect(calcState("working", { type: "start" })).toBe("working");
        expect(calcState("waiting", { type: "start" })).toBe("waiting");
        expect(calcState("completed", { type: "start" })).toBe("completed");
        expect(calcState("failed", { type: "start" })).toBe("failed");
      });
    });

    describe("busy event", () => {
      it("should transition idle → working on busy", () => {
        expect(calcState("idle", { type: "busy" })).toBe("working");
      });

      it("should transition waiting → working on busy", () => {
        expect(calcState("waiting", { type: "busy" })).toBe("working");
      });

      it("should stay in working on busy", () => {
        expect(calcState("working", { type: "busy" })).toBe("working");
      });

      it("should transition completed → working on busy (resuming work)", () => {
        expect(calcState("completed", { type: "busy" })).toBe("working");
      });

      it("should not transition from failed state on busy", () => {
        expect(calcState("failed", { type: "busy" })).toBe("failed");
      });
    });

    describe("prompt event", () => {
      it("should transition working → waiting on prompt", () => {
        expect(calcState("working", { type: "prompt" })).toBe("waiting");
      });

      it("should transition completed → waiting on prompt", () => {
        expect(calcState("completed", { type: "prompt" })).toBe("waiting");
      });

      it("should not transition from other states on prompt", () => {
        expect(calcState("idle", { type: "prompt" })).toBe("idle");
        expect(calcState("waiting", { type: "prompt" })).toBe("waiting");
        expect(calcState("failed", { type: "prompt" })).toBe("failed");
      });
    });

    describe("input event", () => {
      it("should transition waiting → working on input", () => {
        expect(calcState("waiting", { type: "input" })).toBe("working");
      });

      it("should transition idle → working on input", () => {
        expect(calcState("idle", { type: "input" })).toBe("working");
      });

      it("should transition completed → working on input", () => {
        expect(calcState("completed", { type: "input" })).toBe("working");
      });

      it("should transition failed → working on input", () => {
        expect(calcState("failed", { type: "input" })).toBe("working");
      });

      it("should not transition from working on input", () => {
        expect(calcState("working", { type: "input" })).toBe("working");
      });

      it("should not allow heuristic events to escape failed state", () => {
        expect(calcState("failed", { type: "busy" })).toBe("failed");
        expect(calcState("failed", { type: "prompt" })).toBe("failed");
        expect(calcState("failed", { type: "output", data: "x" })).toBe("failed");
      });
    });

    describe("exit event", () => {
      it("should transition working → completed on exit code 0", () => {
        expect(calcState("working", { type: "exit", code: 0 })).toBe("completed");
      });

      it("should transition working → failed on non-zero exit code", () => {
        expect(calcState("working", { type: "exit", code: 1 })).toBe("failed");
      });

      it("should transition waiting → completed on exit code 0", () => {
        expect(calcState("waiting", { type: "exit", code: 0 })).toBe("completed");
      });

      it("should transition waiting → failed on non-zero exit code", () => {
        expect(calcState("waiting", { type: "exit", code: 1 })).toBe("failed");
      });

      it("should transition completed → failed on non-zero exit", () => {
        expect(calcState("completed", { type: "exit", code: 1 })).toBe("failed");
      });

      it("should return null (no-op) on zero exit from completed", () => {
        const state = createTerminalState("t1", "agent1");
        state.agentState = "completed";
        const result = calculateStateChange(state, { type: "exit", code: 0 });
        expect(result).toBeNull();
      });

      it("should not transition from other states on exit", () => {
        expect(calcState("idle", { type: "exit", code: 0 })).toBe("idle");
        expect(calcState("failed", { type: "exit", code: 0 })).toBe("failed");
      });
    });

    describe("error event", () => {
      it("should transition to failed from any state", () => {
        const event: AgentEvent = { type: "error", error: "Something went wrong" };
        const states: AgentState[] = ["idle", "working", "waiting", "completed", "failed"];

        for (const state of states) {
          expect(calcState(state, event)).toBe("failed");
        }
      });
    });

    describe("output event", () => {
      it("should not change state on output", () => {
        const event: AgentEvent = { type: "output", data: "Some output" };
        expect(calcState("working", event)).toBe("working");
        expect(calcState("idle", event)).toBe("idle");
        expect(calcState("waiting", event)).toBe("waiting");
        expect(calcState("completed", event)).toBe("completed");
        expect(calcState("failed", event)).toBe("failed");
      });
    });
  });

  describe("calculateStateChange", () => {
    it("should return null when agentId is undefined", () => {
      const state = createTerminalState("t1");
      state.agentState = "idle";
      const result = calculateStateChange(state, { type: "start" });
      expect(result).toBeNull();
    });

    it("should return null when state does not change", () => {
      const state = createTerminalState("t1", "agent1");
      state.agentState = "working";
      const result = calculateStateChange(state, { type: "output", data: "x" });
      expect(result).toBeNull();
    });

    it("should return StateChangeResult when state changes", () => {
      const state = createTerminalState("t1", "agent1", "wt1", "trace1");
      state.agentState = "idle";
      const result = calculateStateChange(state, { type: "start" });

      expect(result).not.toBeNull();
      const r = result as StateChangeResult;
      expect(r.agentId).toBe("agent1");
      expect(r.state).toBe("working");
      expect(r.previousState).toBe("idle");
      expect(r.terminalId).toBe("t1");
      expect(r.worktreeId).toBe("wt1");
      expect(r.traceId).toBe("trace1");
      expect(typeof r.timestamp).toBe("number");
      expect(r.timestamp).toBeGreaterThan(0);
      expect(typeof r.trigger).toBe("string");
      expect(typeof r.confidence).toBe("number");
    });

    it("should emit completed → working with correct fields on busy", () => {
      const state = createTerminalState("t1", "agent1");
      state.agentState = "completed";
      const result = calculateStateChange(state, { type: "busy" });

      expect(result).not.toBeNull();
      const r = result as StateChangeResult;
      expect(r.state).toBe("working");
      expect(r.previousState).toBe("completed");
      expect(r.trigger).toBe("activity");
    });

    it("should emit completed → waiting with correct fields on prompt", () => {
      const state = createTerminalState("t1", "agent1");
      state.agentState = "completed";
      const result = calculateStateChange(state, { type: "prompt" });

      expect(result).not.toBeNull();
      const r = result as StateChangeResult;
      expect(r.state).toBe("waiting");
      expect(r.previousState).toBe("completed");
      expect(r.trigger).toBe("activity");
    });

    it("should emit completed → failed with correct fields on non-zero exit", () => {
      const state = createTerminalState("t1", "agent1");
      state.agentState = "completed";
      const result = calculateStateChange(state, { type: "exit", code: 1 });

      expect(result).not.toBeNull();
      const r = result as StateChangeResult;
      expect(r.state).toBe("failed");
      expect(r.previousState).toBe("completed");
      expect(r.trigger).toBe("exit");
    });
  });

  describe("createTerminalState", () => {
    it("should create state with correct defaults", () => {
      const state = createTerminalState("t1", "agent1");
      expect(state.terminalId).toBe("t1");
      expect(state.agentId).toBe("agent1");
      expect(state.agentState).toBe("idle");
      expect(state.analysisBuffer).toBe("");
      expect(state.seenArtifactIds).toBeInstanceOf(Set);
      expect(state.seenArtifactIds.size).toBe(0);
    });

    it("should accept optional parameters", () => {
      const state = createTerminalState("t1", "agent1", "wt1", "trace1", "working");
      expect(state.worktreeId).toBe("wt1");
      expect(state.traceId).toBe("trace1");
      expect(state.agentState).toBe("working");
    });

    it("should create state without agentId", () => {
      const state = createTerminalState("t1");
      expect(state.terminalId).toBe("t1");
      expect(state.agentId).toBeUndefined();
    });
  });

  describe("pruneSeenArtifacts", () => {
    it("should not prune when under limit", () => {
      const seenIds = new Set(["a", "b", "c"]);
      pruneSeenArtifacts(seenIds);
      expect(seenIds.size).toBe(3);
    });

    it("should not prune when at limit", () => {
      const seenIds = new Set<string>();
      for (let i = 0; i < 1000; i++) {
        seenIds.add(`id-${i}`);
      }
      pruneSeenArtifacts(seenIds);
      expect(seenIds.size).toBe(1000);
    });

    it("should prune to limit keeping newest entries", () => {
      const seenIds = new Set<string>();
      for (let i = 0; i < 1050; i++) {
        seenIds.add(`id-${i}`);
      }
      expect(seenIds.size).toBe(1050);
      pruneSeenArtifacts(seenIds);
      expect(seenIds.size).toBe(1000);
      // Oldest entries (0-49) should be removed, newest (50-1049) kept
      expect(seenIds.has("id-0")).toBe(false);
      expect(seenIds.has("id-49")).toBe(false);
      expect(seenIds.has("id-50")).toBe(true);
      expect(seenIds.has("id-1049")).toBe(true);
    });
  });
});
