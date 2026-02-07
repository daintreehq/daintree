import { describe, it, expect } from "vitest";
import {
  nextAgentState,
  isValidTransition,
  getStateChangeTimestamp,
  type AgentEvent,
} from "../AgentStateMachine.js";
import type { AgentState } from "../../types/index.js";

describe("AgentStateMachine", () => {
  describe("isValidTransition", () => {
    it("should allow idle → working", () => {
      expect(isValidTransition("idle", "working")).toBe(true);
    });

    it("should allow idle → failed", () => {
      expect(isValidTransition("idle", "failed")).toBe(true);
    });

    it("should allow working → waiting", () => {
      expect(isValidTransition("working", "waiting")).toBe(true);
    });

    it("should allow working → completed", () => {
      expect(isValidTransition("working", "completed")).toBe(true);
    });

    it("should allow working → failed", () => {
      expect(isValidTransition("working", "failed")).toBe(true);
    });

    it("should allow waiting → working", () => {
      expect(isValidTransition("waiting", "working")).toBe(true);
    });

    it("should allow waiting → failed", () => {
      expect(isValidTransition("waiting", "failed")).toBe(true);
    });

    it("should allow completed → failed (error override)", () => {
      expect(isValidTransition("completed", "failed")).toBe(true);
    });

    it("should not allow completed → other states", () => {
      expect(isValidTransition("completed", "idle")).toBe(false);
      expect(isValidTransition("completed", "working")).toBe(false);
      expect(isValidTransition("completed", "waiting")).toBe(false);
    });

    it("should allow failed → failed (error update)", () => {
      expect(isValidTransition("failed", "failed")).toBe(true);
    });

    it("should not allow failed → other states", () => {
      expect(isValidTransition("failed", "idle")).toBe(false);
      expect(isValidTransition("failed", "working")).toBe(false);
      expect(isValidTransition("failed", "waiting")).toBe(false);
      expect(isValidTransition("failed", "completed")).toBe(false);
    });

    it("should not allow invalid transitions", () => {
      expect(isValidTransition("idle", "waiting")).toBe(false);
      expect(isValidTransition("idle", "completed")).toBe(false);
      expect(isValidTransition("waiting", "completed")).toBe(false);
    });
  });

  describe("nextAgentState", () => {
    describe("start event", () => {
      it("should transition idle → working on start", () => {
        const event: AgentEvent = { type: "start" };
        expect(nextAgentState("idle", event)).toBe("working");
      });

      it("should not transition from other states on start", () => {
        const event: AgentEvent = { type: "start" };
        expect(nextAgentState("working", event)).toBe("working");
        expect(nextAgentState("waiting", event)).toBe("waiting");
        expect(nextAgentState("completed", event)).toBe("completed");
        expect(nextAgentState("failed", event)).toBe("failed");
      });
    });

    describe("busy event (activity-based detection)", () => {
      it("should transition idle → working on busy", () => {
        const event: AgentEvent = { type: "busy" };
        expect(nextAgentState("idle", event)).toBe("working");
      });

      it("should transition waiting → working on busy", () => {
        const event: AgentEvent = { type: "busy" };
        expect(nextAgentState("waiting", event)).toBe("working");
      });

      it("should stay in working on busy", () => {
        const event: AgentEvent = { type: "busy" };
        expect(nextAgentState("working", event)).toBe("working");
      });

      it("should not transition from terminal states on busy", () => {
        const event: AgentEvent = { type: "busy" };
        expect(nextAgentState("completed", event)).toBe("completed");
        expect(nextAgentState("failed", event)).toBe("failed");
      });
    });

    describe("prompt event (activity-based detection)", () => {
      it("should transition working → waiting on prompt", () => {
        const event: AgentEvent = { type: "prompt" };
        expect(nextAgentState("working", event)).toBe("waiting");
      });

      it("should not transition from other states on prompt", () => {
        const event: AgentEvent = { type: "prompt" };
        expect(nextAgentState("idle", event)).toBe("idle");
        expect(nextAgentState("waiting", event)).toBe("waiting");
        expect(nextAgentState("completed", event)).toBe("completed");
        expect(nextAgentState("failed", event)).toBe("failed");
      });
    });

    describe("input event", () => {
      it("should transition waiting → working on input", () => {
        const event: AgentEvent = { type: "input" };
        expect(nextAgentState("waiting", event)).toBe("working");
      });

      it("should transition idle → working on input (Issue #2185)", () => {
        const event: AgentEvent = { type: "input" };
        expect(nextAgentState("idle", event)).toBe("working");
      });

      it("should not transition from other states on input", () => {
        const event: AgentEvent = { type: "input" };
        expect(nextAgentState("working", event)).toBe("working");
        expect(nextAgentState("completed", event)).toBe("completed");
        expect(nextAgentState("failed", event)).toBe("failed");
      });
    });

    describe("exit event", () => {
      it("should transition working → completed on exit code 0", () => {
        const event: AgentEvent = { type: "exit", code: 0 };
        expect(nextAgentState("working", event)).toBe("completed");
      });

      it("should transition working → failed on non-zero exit code", () => {
        const event: AgentEvent = { type: "exit", code: 1 };
        expect(nextAgentState("working", event)).toBe("failed");
      });

      it("should transition waiting → completed on exit code 0", () => {
        const event: AgentEvent = { type: "exit", code: 0 };
        expect(nextAgentState("waiting", event)).toBe("completed");
      });

      it("should transition waiting → failed on non-zero exit code", () => {
        const event: AgentEvent = { type: "exit", code: 1 };
        expect(nextAgentState("waiting", event)).toBe("failed");
      });

      it("should not transition from other states on exit", () => {
        const event: AgentEvent = { type: "exit", code: 0 };
        expect(nextAgentState("idle", event)).toBe("idle");
        expect(nextAgentState("completed", event)).toBe("completed");
        expect(nextAgentState("failed", event)).toBe("failed");
      });
    });

    describe("error event", () => {
      it("should transition to failed from any state", () => {
        const event: AgentEvent = { type: "error", error: "Something went wrong" };
        const states: AgentState[] = ["idle", "working", "waiting", "completed", "failed"];

        for (const state of states) {
          expect(nextAgentState(state, event)).toBe("failed");
        }
      });
    });

    describe("output event (no longer triggers state changes)", () => {
      it("should not change state on output", () => {
        const event: AgentEvent = { type: "output", data: "Some output" };
        expect(nextAgentState("working", event)).toBe("working");
        expect(nextAgentState("idle", event)).toBe("idle");
        expect(nextAgentState("waiting", event)).toBe("waiting");
      });
    });
  });

  describe("getStateChangeTimestamp", () => {
    it("should return a valid timestamp", () => {
      const timestamp = getStateChangeTimestamp();
      expect(typeof timestamp).toBe("number");
      expect(timestamp).toBeGreaterThan(0);
    });

    it("should return current time approximately", () => {
      const before = Date.now();
      const timestamp = getStateChangeTimestamp();
      const after = Date.now();

      expect(timestamp).toBeGreaterThanOrEqual(before);
      expect(timestamp).toBeLessThanOrEqual(after);
    });
  });
});
