import { describe, it, expect } from "vitest";
import {
  VALID_TRANSITIONS,
  isValidTransition,
  nextAgentState,
  type AgentEvent,
} from "../agentFsm.js";
import type { AgentState } from "../../types/agent.js";

describe("agentFsm", () => {
  describe("VALID_TRANSITIONS", () => {
    it("covers all six canonical agent states", () => {
      const keys = Object.keys(VALID_TRANSITIONS).sort();
      expect(keys).toEqual(
        ["completed", "directing", "exited", "idle", "waiting", "working"].sort()
      );
    });

    it("leaves directing empty (renderer-only state, never produced by main process)", () => {
      expect(VALID_TRANSITIONS.directing).toEqual([]);
    });

    it("permits exited → idle for respawn", () => {
      expect(VALID_TRANSITIONS.exited).toEqual(["idle"]);
    });
  });

  describe("FSM invariant", () => {
    // VALID_TRANSITIONS describes the natural lifecycle. `kill` is a hard-reset
    // override that bypasses the table by design, so it is excluded from this
    // invariant. `directing` is renderer-only and never receives main-process
    // events; we don't assert table coverage for transitions out of it.
    it("every natural-lifecycle nextAgentState result is permitted by VALID_TRANSITIONS", () => {
      const states: AgentState[] = ["idle", "working", "waiting", "completed", "exited"];
      const events: AgentEvent[] = [
        { type: "start" },
        { type: "busy" },
        { type: "prompt" },
        { type: "completion" },
        { type: "input" },
        { type: "exit", code: 0 },
        { type: "respawn" },
        { type: "watchdog-timeout" },
        { type: "error", error: "x" },
        { type: "output", data: "x" },
      ];
      for (const from of states) {
        for (const event of events) {
          const to = nextAgentState(from, event);
          if (to !== from) {
            expect(
              isValidTransition(from, to),
              `${from} -[${event.type}]-> ${to} must be in VALID_TRANSITIONS`
            ).toBe(true);
          }
        }
      }
    });
  });

  describe("isValidTransition", () => {
    it("allows canonical forward transitions", () => {
      expect(isValidTransition("idle", "working")).toBe(true);
      expect(isValidTransition("working", "waiting")).toBe(true);
      expect(isValidTransition("working", "completed")).toBe(true);
      expect(isValidTransition("waiting", "working")).toBe(true);
      expect(isValidTransition("completed", "working")).toBe(true);
      expect(isValidTransition("exited", "idle")).toBe(true);
    });

    it("rejects all transitions out of directing (renderer-managed state)", () => {
      expect(isValidTransition("directing", "idle")).toBe(false);
      expect(isValidTransition("directing", "working")).toBe(false);
      expect(isValidTransition("directing", "waiting")).toBe(false);
      expect(isValidTransition("directing", "completed")).toBe(false);
      expect(isValidTransition("directing", "exited")).toBe(false);
    });

    it("rejects unknown transitions", () => {
      expect(isValidTransition("idle", "completed")).toBe(false);
      expect(isValidTransition("idle", "waiting")).toBe(false);
      expect(isValidTransition("exited", "working")).toBe(false);
    });
  });

  describe("nextAgentState", () => {
    it("transitions idle → working on start", () => {
      expect(nextAgentState("idle", { type: "start" })).toBe("working");
    });

    it("transitions idle/waiting/completed → working on busy", () => {
      expect(nextAgentState("idle", { type: "busy" })).toBe("working");
      expect(nextAgentState("waiting", { type: "busy" })).toBe("working");
      expect(nextAgentState("completed", { type: "busy" })).toBe("working");
    });

    it("transitions working → completed on completion", () => {
      expect(nextAgentState("working", { type: "completion" })).toBe("completed");
    });

    it("ignores completion from non-working states", () => {
      expect(nextAgentState("idle", { type: "completion" })).toBe("idle");
      expect(nextAgentState("waiting", { type: "completion" })).toBe("waiting");
      expect(nextAgentState("completed", { type: "completion" })).toBe("completed");
    });

    it("transitions working/completed → waiting on prompt", () => {
      expect(nextAgentState("working", { type: "prompt" })).toBe("waiting");
      expect(nextAgentState("completed", { type: "prompt" })).toBe("waiting");
    });

    it("transitions waiting/idle/completed → working on input", () => {
      expect(nextAgentState("waiting", { type: "input" })).toBe("working");
      expect(nextAgentState("idle", { type: "input" })).toBe("working");
      expect(nextAgentState("completed", { type: "input" })).toBe("working");
    });

    it("transitions any non-exited state → exited on exit", () => {
      const states: AgentState[] = ["idle", "working", "waiting", "completed"];
      for (const state of states) {
        expect(nextAgentState(state, { type: "exit", code: 0 })).toBe("exited");
      }
    });

    it("does not retransition exited on exit (terminal state)", () => {
      expect(nextAgentState("exited", { type: "exit", code: 0 })).toBe("exited");
    });

    it("treats kill as a hard reset to idle from any state", () => {
      const states: AgentState[] = [
        "idle",
        "working",
        "waiting",
        "directing",
        "completed",
        "exited",
      ];
      for (const state of states) {
        expect(nextAgentState(state, { type: "kill" })).toBe("idle");
      }
    });

    it("transitions exited → idle on respawn", () => {
      expect(nextAgentState("exited", { type: "respawn" })).toBe("idle");
    });

    it("ignores respawn from non-exited states", () => {
      expect(nextAgentState("idle", { type: "respawn" })).toBe("idle");
      expect(nextAgentState("working", { type: "respawn" })).toBe("working");
    });

    it("transitions waiting → idle on watchdog-timeout", () => {
      expect(nextAgentState("waiting", { type: "watchdog-timeout" })).toBe("idle");
    });

    it("ignores watchdog-timeout from non-waiting states", () => {
      expect(nextAgentState("working", { type: "watchdog-timeout" })).toBe("working");
      expect(nextAgentState("completed", { type: "watchdog-timeout" })).toBe("completed");
      expect(nextAgentState("exited", { type: "watchdog-timeout" })).toBe("exited");
    });

    it("treats error events as no-ops in every state", () => {
      const states: AgentState[] = ["idle", "working", "waiting", "completed", "exited"];
      for (const state of states) {
        expect(nextAgentState(state, { type: "error", error: "boom" })).toBe(state);
      }
    });

    it("treats output events as no-ops", () => {
      expect(nextAgentState("working", { type: "output", data: "x" })).toBe("working");
      expect(nextAgentState("idle", { type: "output", data: "x" })).toBe("idle");
    });

    it("guards against malformed events", () => {
      expect(nextAgentState("working", null as unknown as AgentEvent)).toBe("working");
      expect(nextAgentState("working", undefined as unknown as AgentEvent)).toBe("working");
      expect(nextAgentState("working", {} as unknown as AgentEvent)).toBe("working");
    });

    it("ignores exit events without a numeric code", () => {
      const malformed = { type: "exit" } as unknown as AgentEvent;
      expect(nextAgentState("working", malformed)).toBe("working");
    });
  });
});
