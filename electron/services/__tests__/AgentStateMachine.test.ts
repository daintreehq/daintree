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

    it("should not allow idle → failed", () => {
      expect(isValidTransition("idle", "failed")).toBe(false);
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

    it("should allow completed → waiting (prompt after completion)", () => {
      expect(isValidTransition("completed", "waiting")).toBe(true);
    });

    it("should allow completed → working (resuming work)", () => {
      expect(isValidTransition("completed", "working")).toBe(true);
    });

    it("should not allow completed → other states", () => {
      expect(isValidTransition("completed", "idle")).toBe(false);
    });

    it("should allow failed → failed (error update)", () => {
      expect(isValidTransition("failed", "failed")).toBe(true);
    });

    it("should allow failed → working (user input recovery)", () => {
      expect(isValidTransition("failed", "working")).toBe(true);
    });

    it("should allow failed → idle (kill recovery)", () => {
      expect(isValidTransition("failed", "idle")).toBe(true);
    });

    it("should allow failed → waiting (prompt recovery)", () => {
      expect(isValidTransition("failed", "waiting")).toBe(true);
    });

    it("should allow failed → completed (routine exit recovery)", () => {
      expect(isValidTransition("failed", "completed")).toBe(true);
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

      it("should transition completed → working on busy (resuming work)", () => {
        const event: AgentEvent = { type: "busy" };
        expect(nextAgentState("completed", event)).toBe("working");
      });

      it("should transition failed → working on busy (activity recovery)", () => {
        const event: AgentEvent = { type: "busy" };
        expect(nextAgentState("failed", event)).toBe("working");
      });
    });

    describe("prompt event (activity-based detection)", () => {
      it("should transition working → waiting on prompt", () => {
        const event: AgentEvent = { type: "prompt" };
        expect(nextAgentState("working", event)).toBe("waiting");
      });

      it("should transition completed → waiting on prompt", () => {
        const event: AgentEvent = { type: "prompt" };
        expect(nextAgentState("completed", event)).toBe("waiting");
      });

      it("should transition failed → waiting on prompt (silence recovery)", () => {
        const event: AgentEvent = { type: "prompt" };
        expect(nextAgentState("failed", event)).toBe("waiting");
      });

      it("should not transition from other states on prompt", () => {
        const event: AgentEvent = { type: "prompt" };
        expect(nextAgentState("idle", event)).toBe("idle");
        expect(nextAgentState("waiting", event)).toBe("waiting");
      });
    });

    describe("completion event (pattern-detected task completion)", () => {
      it("should transition working → completed on completion", () => {
        const event: AgentEvent = { type: "completion" };
        expect(nextAgentState("working", event)).toBe("completed");
      });

      it("should not transition from other states on completion", () => {
        const event: AgentEvent = { type: "completion" };
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

      it("should transition completed → working on input (resuming work)", () => {
        const event: AgentEvent = { type: "input" };
        expect(nextAgentState("completed", event)).toBe("working");
      });

      it("should transition failed → working on input (Issue #3190)", () => {
        const event: AgentEvent = { type: "input" };
        expect(nextAgentState("failed", event)).toBe("working");
      });

      it("should not transition from working on input", () => {
        const event: AgentEvent = { type: "input" };
        expect(nextAgentState("working", event)).toBe("working");
      });

      it("should not allow completion or output events to escape failed state", () => {
        expect(nextAgentState("failed", { type: "completion" })).toBe("failed");
        expect(nextAgentState("failed", { type: "output", data: "x" })).toBe("failed");
      });
    });

    describe("exit event", () => {
      it("should transition working → completed on exit code 0", () => {
        const event: AgentEvent = { type: "exit", code: 0 };
        expect(nextAgentState("working", event)).toBe("completed");
      });

      it("should transition working → completed on non-crash exit code", () => {
        const event: AgentEvent = { type: "exit", code: 1 };
        expect(nextAgentState("working", event)).toBe("completed");
      });

      it("should transition working → completed on routine signal exit (SIGINT)", () => {
        expect(nextAgentState("working", { type: "exit", code: 0, signal: 2 })).toBe("completed");
      });

      it("should transition working → completed on routine exit code (130 = SIGINT)", () => {
        expect(nextAgentState("working", { type: "exit", code: 130 })).toBe("completed");
      });

      it("should transition working → completed on SIGHUP signal", () => {
        expect(nextAgentState("working", { type: "exit", code: 0, signal: 1 })).toBe("completed");
      });

      it("should transition working → completed on SIGTERM exit code (143)", () => {
        expect(nextAgentState("working", { type: "exit", code: 143 })).toBe("completed");
      });

      it("should transition working → failed on crash signal (SIGSEGV)", () => {
        expect(nextAgentState("working", { type: "exit", code: 139 })).toBe("failed");
      });

      it("should transition waiting → completed on exit code 0", () => {
        const event: AgentEvent = { type: "exit", code: 0 };
        expect(nextAgentState("waiting", event)).toBe("completed");
      });

      it("should transition waiting → completed on non-crash exit code", () => {
        const event: AgentEvent = { type: "exit", code: 1 };
        expect(nextAgentState("waiting", event)).toBe("completed");
      });

      it("should transition waiting → completed on routine exit (SIGTERM)", () => {
        expect(nextAgentState("waiting", { type: "exit", code: 143 })).toBe("completed");
      });

      it("should stay completed on non-crash exit from completed", () => {
        const event: AgentEvent = { type: "exit", code: 1 };
        expect(nextAgentState("completed", event)).toBe("completed");
      });

      it("should transition working → failed on crash signal exit (SIGABRT)", () => {
        expect(nextAgentState("working", { type: "exit", code: 134 })).toBe("failed");
      });

      it("should stay completed on zero exit from completed", () => {
        const event: AgentEvent = { type: "exit", code: 0 };
        expect(nextAgentState("completed", event)).toBe("completed");
      });

      it("should not transition from other states on exit", () => {
        const event: AgentEvent = { type: "exit", code: 0 };
        expect(nextAgentState("idle", event)).toBe("idle");
        expect(nextAgentState("failed", event)).toBe("failed");
      });
    });

    describe("kill event", () => {
      it("should transition to idle from any state", () => {
        const event: AgentEvent = { type: "kill" };
        const states: AgentState[] = ["idle", "working", "waiting", "completed", "failed"];

        for (const state of states) {
          expect(nextAgentState(state, event)).toBe("idle");
        }
      });
    });

    describe("error event (no-op)", () => {
      it("should not change state on error event", () => {
        const event: AgentEvent = { type: "error", error: "Something went wrong" };
        const states: AgentState[] = ["idle", "working", "waiting", "completed", "failed"];

        for (const state of states) {
          expect(nextAgentState(state, event)).toBe(state);
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
