import { describe, expect } from "vitest";
import { fc, test } from "@fast-check/vitest";
import {
  VALID_TRANSITIONS,
  isValidTransition,
  nextAgentState,
  type AgentEvent,
} from "../agentFsm.js";
import type { AgentState } from "../../types/agent.js";

const ALL_STATES = ["idle", "working", "waiting", "directing", "completed", "exited"] as const;
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

const stateArb = fc.constantFrom(...ALL_STATES);
const mainProcessStateArb = fc.constantFrom(...MAIN_PROCESS_STATES);
const inputRecoveryStateArb = fc.constantFrom(
  "idle" as const,
  "waiting" as const,
  "completed" as const
);

// Derive arbitraries directly from `eventConstructors` so adding a new variant
// flows through the `satisfies` ratchet into both arbitraries automatically.
const eventArb: fc.Arbitrary<AgentEvent> = fc.oneof(
  ...(Object.values(eventConstructors) as fc.Arbitrary<AgentEvent>[])
);

// Natural-lifecycle events: everything except `kill`, which is a hard-reset
// override that bypasses VALID_TRANSITIONS by design.
const naturalEventArb: fc.Arbitrary<AgentEvent> = fc.oneof(
  ...(Object.entries(eventConstructors)
    .filter(([type]) => type !== "kill")
    .map(([, arb]) => arb) as fc.Arbitrary<AgentEvent>[])
);

describe("agentFsm property tests", () => {
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

  test.prop([stateArb])("kill is a hard reset to idle from any state", (from) => {
    expect(nextAgentState(from, { type: "kill" })).toBe("idle");
  });

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

  test.prop([stateArb, fc.array(eventArb, { maxLength: 50 })])(
    "any event sequence from any state lands in a canonical AgentState",
    (start, events) => {
      const terminal = events.reduce<AgentState>(
        (state, event) => nextAgentState(state, event),
        start
      );
      expect(ALL_STATES).toContain(terminal);
    }
  );

  test.prop([stateArb, stateArb])(
    "isValidTransition agrees with VALID_TRANSITIONS membership for every cell",
    (from, to) => {
      expect(isValidTransition(from, to)).toBe(VALID_TRANSITIONS[from].includes(to));
    }
  );

  // Per the FSM spec, `directing` is a renderer-only state — no main-process
  // natural event should ever produce it. We use `mainProcessStateArb` here
  // because the from-directing exit behavior is intentionally not asserted:
  // `nextAgentState("directing", { type: "exit", code: N })` returns `"exited"`
  // (the `exit` case fires for any non-`exited` current state), and the
  // existing hand-written invariant test in `agentFsm.test.ts` likewise
  // excludes `directing` from its from-state set for the same reason.
  test.prop([mainProcessStateArb, naturalEventArb])(
    "no natural-lifecycle event from a non-directing state produces directing",
    (from, event) => {
      expect(nextAgentState(from, event)).not.toBe("directing");
    }
  );
});
