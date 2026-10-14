import { describe, it, expect } from "vitest";
import { nextAgentState, type AgentEvent } from "../AgentStateMachine.js";

describe("AgentStateMachine", () => {
  describe("nextAgentState", () => {
    describe("start event", () => {
      it("should not transition from other states on start", () => {
        const event: AgentEvent = { type: "start" };
        expect(nextAgentState("working", event)).toBe("working");
        expect(nextAgentState("waiting", event)).toBe("waiting");
        expect(nextAgentState("completed", event)).toBe("completed");
        expect(nextAgentState("exited", event)).toBe("exited");
      });
    });

    describe("busy event (activity-based detection)", () => {
      it("should stay in working on busy", () => {
        const event: AgentEvent = { type: "busy" };
        expect(nextAgentState("working", event)).toBe("working");
      });
    });

    describe("prompt event (activity-based detection)", () => {
      it("should not transition from other states on prompt", () => {
        const event: AgentEvent = { type: "prompt" };
        expect(nextAgentState("idle", event)).toBe("idle");
        expect(nextAgentState("waiting", event)).toBe("waiting");
      });
    });

    describe("input event", () => {
      it("should not transition from working on input", () => {
        const event: AgentEvent = { type: "input" };
        expect(nextAgentState("working", event)).toBe("working");
      });
    });

    describe("exit event", () => {
      it("should transition working → exited on non-crash exit code", () => {
        const event: AgentEvent = { type: "exit", code: 1 };
        expect(nextAgentState("working", event)).toBe("exited");
      });

      it("should transition working → exited on crash signal (SIGSEGV)", () => {
        expect(nextAgentState("working", { type: "exit", code: 139 })).toBe("exited");
      });
    });

    describe("watchdog-timeout event", () => {
      it("should not transition from idle on watchdog-timeout", () => {
        const event: AgentEvent = { type: "watchdog-timeout" };
        expect(nextAgentState("idle", event)).toBe("idle");
      });
    });

    describe("output event", () => {
      it("should ignore empty output", () => {
        const event: AgentEvent = { type: "output", data: "" };
        expect(nextAgentState("idle", event)).toBe("idle");
        expect(nextAgentState("waiting", event)).toBe("waiting");
      });
    });
  });
});
