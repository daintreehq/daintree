import { describe, it, expect } from "vitest";
import { fc, test } from "@fast-check/vitest";
import {
  VALID_TRANSITIONS,
  isValidTransition,
  nextAgentState,
  type AgentEvent,
} from "../agentFsm.js";
import type { AgentState } from "../../types/agent.js";

describe("agentFsm", () => {
  describe("VALID_TRANSITIONS", () => {
    it("leaves directing empty (renderer-only state, never produced by main process)", () => {
      expect(VALID_TRANSITIONS.directing).toEqual([]);
    });

    it("permits exited → idle for respawn", () => {
      expect(VALID_TRANSITIONS.exited).toEqual(["idle"]);
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

    it("transitions any non-exited state → exited on exit", () => {
      const states: AgentState[] = ["idle", "working", "waiting", "completed"];
      for (const state of states) {
        expect(nextAgentState(state, { type: "exit", code: 0 })).toBe("exited");
      }
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

    it("treats output as working activity", () => {
      expect(nextAgentState("working", { type: "output", data: "x" })).toBe("working");
      expect(nextAgentState("idle", { type: "output", data: "x" })).toBe("working");
      expect(nextAgentState("waiting", { type: "output", data: "x" })).toBe("working");
      expect(nextAgentState("completed", { type: "output", data: "x" })).toBe("working");
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

const MAIN_PROCESS_STATES = ["idle", "working", "waiting", "completed", "exited"] as const;

// `satisfies Record<AgentEvent["type"], ...>` is a compile-time coverage ratchet:
// adding a new variant to AgentEvent forces a corresponding entry here before
// these tests will compile. The exit constructor MUST emit a numeric `code` —
// the FSM treats exit events without one as no-ops (agentFsm.ts:47-49), so
// omitting the code would silently hide → exited transitions in sequence tests.
const eventConstructors = {
  start: fc.constant({ type: "start" } as const),
  busy: fc.constant({ type: "busy" } as const),
  output: fc.record({ type: fc.constant("output" as const), data: fc.string() }),
  prompt: fc.constant({ type: "prompt" } as const),
  completion: fc.constant({ type: "completion" } as const),
  input: fc.constant({ type: "input" } as const),
  exit: fc.record({ type: fc.constant("exit" as const), code: fc.integer() }),
  error: fc.record({ type: fc.constant("error" as const), error: fc.string() }),
  kill: fc.constant({ type: "kill" } as const),
  respawn: fc.constant({ type: "respawn" } as const),
  "watchdog-timeout": fc.constant({ type: "watchdog-timeout" } as const),
} satisfies Record<AgentEvent["type"], fc.Arbitrary<AgentEvent>>;

const mainProcessStateArb = fc.constantFrom(...MAIN_PROCESS_STATES);
const inputRecoveryStateArb = fc.constantFrom(
  "idle" as const,
  "waiting" as const,
  "completed" as const
);

// Natural-lifecycle events: everything except `kill`, which is a hard-reset
// override that bypasses VALID_TRANSITIONS by design.
const naturalEventArb: fc.Arbitrary<AgentEvent> = fc.oneof(
  ...(Object.entries(eventConstructors)
    .filter(([type]) => type !== "kill")
    .map(([, arb]) => arb) as fc.Arbitrary<AgentEvent>[])
);

describe("agentFsm property tests", () => {
  // `directing` is renderer-only and never receives main-process events, so it
  // is excluded from the from-states; since no row of VALID_TRANSITIONS lists
  // `directing`, this also proves no natural event produces it.
  test.prop([mainProcessStateArb, naturalEventArb])(
    "every state-changing natural-lifecycle transition is permitted by VALID_TRANSITIONS",
    (from, event) => {
      const to = nextAgentState(from, event);
      if (to !== from) {
        expect(VALID_TRANSITIONS[from]).toContain(to);
        expect(isValidTransition(from, to)).toBe(true);
      }
    }
  );

  test.prop([naturalEventArb])(
    "exited is quasi-terminal under any natural event other than respawn",
    (event) => {
      fc.pre(event.type !== "respawn");
      expect(nextAgentState("exited", event)).toBe("exited");
    }
  );

  test.prop([inputRecoveryStateArb])(
    "input event recovers idle/waiting/completed to working (#3195 regression guard)",
    (from) => {
      expect(nextAgentState(from, { type: "input" })).toBe("working");
    }
  );
});
