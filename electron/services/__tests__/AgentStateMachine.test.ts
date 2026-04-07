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

    it("should allow working → waiting", () => {
      expect(isValidTransition("working", "waiting")).toBe(true);
    });

    it("should allow working → completed", () => {
      expect(isValidTransition("working", "completed")).toBe(true);
    });

    it("should allow waiting → working", () => {
      expect(isValidTransition("waiting", "working")).toBe(true);
    });

    it("should allow waiting → completed", () => {
      expect(isValidTransition("waiting", "completed")).toBe(true);
    });

    it("should allow waiting → exited (exit while waiting)", () => {
      expect(isValidTransition("waiting", "exited")).toBe(true);
    });

    it("should allow completed → waiting (prompt after completion)", () => {
      expect(isValidTransition("completed", "waiting")).toBe(true);
    });

    it("should allow completed → working (resuming work)", () => {
      expect(isValidTransition("completed", "working")).toBe(true);
    });

    it("should allow completed → exited (exit from completed)", () => {
      expect(isValidTransition("completed", "exited")).toBe(true);
    });

    it("should not allow completed → idle", () => {
      expect(isValidTransition("completed", "idle")).toBe(false);
    });

    it("should not allow exited → any state (terminal state)", () => {
      expect(isValidTransition("exited", "idle")).toBe(false);
      expect(isValidTransition("exited", "working")).toBe(false);
      expect(isValidTransition("exited", "completed")).toBe(false);
    });

    it("should not allow invalid transitions", () => {
      expect(isValidTransition("idle", "waiting")).toBe(false);
      expect(isValidTransition("idle", "completed")).toBe(false);
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
        expect(nextAgentState("exited", event)).toBe("exited");
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

      it("should not transition from working on input", () => {
        const event: AgentEvent = { type: "input" };
        expect(nextAgentState("working", event)).toBe("working");
      });
    });

    describe("exit event", () => {
      it("should transition working → exited on exit code 0", () => {
        const event: AgentEvent = { type: "exit", code: 0 };
        expect(nextAgentState("working", event)).toBe("exited");
      });

      it("should transition working → exited on non-crash exit code", () => {
        const event: AgentEvent = { type: "exit", code: 1 };
        expect(nextAgentState("working", event)).toBe("exited");
      });

      it("should transition working → exited on routine signal exit (SIGINT)", () => {
        expect(nextAgentState("working", { type: "exit", code: 0, signal: 2 })).toBe("exited");
      });

      it("should transition working → exited on routine exit code (130 = SIGINT)", () => {
        expect(nextAgentState("working", { type: "exit", code: 130 })).toBe("exited");
      });

      it("should transition working → exited on SIGHUP signal", () => {
        expect(nextAgentState("working", { type: "exit", code: 0, signal: 1 })).toBe("exited");
      });

      it("should transition working → exited on SIGTERM exit code (143)", () => {
        expect(nextAgentState("working", { type: "exit", code: 143 })).toBe("exited");
      });

      it("should transition working → exited on crash signal (SIGSEGV)", () => {
        expect(nextAgentState("working", { type: "exit", code: 139 })).toBe("exited");
      });

      it("should transition waiting → exited on exit code 0", () => {
        const event: AgentEvent = { type: "exit", code: 0 };
        expect(nextAgentState("waiting", event)).toBe("exited");
      });

      it("should transition waiting → exited on non-crash exit code", () => {
        const event: AgentEvent = { type: "exit", code: 1 };
        expect(nextAgentState("waiting", event)).toBe("exited");
      });

      it("should transition waiting → exited on routine exit (SIGTERM)", () => {
        expect(nextAgentState("waiting", { type: "exit", code: 143 })).toBe("exited");
      });

      it("should transition waiting → exited on crash signal exit (SIGSEGV)", () => {
        expect(nextAgentState("waiting", { type: "exit", code: 139 })).toBe("exited");
      });

      it("should transition completed → exited on exit", () => {
        const event: AgentEvent = { type: "exit", code: 1 };
        expect(nextAgentState("completed", event)).toBe("exited");
      });

      it("should transition working → exited on crash signal exit (SIGABRT)", () => {
        expect(nextAgentState("working", { type: "exit", code: 134 })).toBe("exited");
      });

      it("should transition completed → exited on crash signal exit (SIGABRT)", () => {
        expect(nextAgentState("completed", { type: "exit", code: 134 })).toBe("exited");
      });

      it("should transition completed → exited on zero exit", () => {
        const event: AgentEvent = { type: "exit", code: 0 };
        expect(nextAgentState("completed", event)).toBe("exited");
      });

      it("should not transition from idle on exit", () => {
        const event: AgentEvent = { type: "exit", code: 0 };
        expect(nextAgentState("idle", event)).toBe("idle");
      });

      it("should not transition from exited on exit (terminal state)", () => {
        const event: AgentEvent = { type: "exit", code: 0 };
        expect(nextAgentState("exited", event)).toBe("exited");
      });
    });

    describe("kill event", () => {
      it("should transition to idle from any state", () => {
        const event: AgentEvent = { type: "kill" };
        const states: AgentState[] = ["idle", "working", "waiting", "completed", "exited"];

        for (const state of states) {
          expect(nextAgentState(state, event)).toBe("idle");
        }
      });
    });

    describe("error event (no-op)", () => {
      it("should not change state on error event", () => {
        const event: AgentEvent = { type: "error", error: "Something went wrong" };
        const states: AgentState[] = ["idle", "working", "waiting", "completed", "exited"];

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
