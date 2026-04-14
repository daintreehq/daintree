import { describe, expect, it } from "vitest";

import { nextAgentState, type AgentEvent } from "../AgentStateMachine.js";
import type { AgentState } from "../../types/index.js";

function applyEvents(initial: AgentState, events: AgentEvent[]): AgentState {
  return events.reduce((state, event) => nextAgentState(state, event), initial);
}

describe("AgentStateMachine adversarial", () => {
  it("keeps invalid event sequences in terminal states", () => {
    expect(
      applyEvents("working", [
        { type: "exit", code: 0 },
        { type: "output", data: "late output" },
        { type: "completion" },
      ])
    ).toBe("exited");

    expect(
      applyEvents("working", [
        { type: "completion" },
        { type: "start" },
        { type: "output", data: "ignored" },
      ])
    ).toBe("completed");
  });

  it("treats malformed runtime events as no-ops instead of throwing", () => {
    const malformedEvents: unknown[] = [
      null,
      undefined,
      42,
      "busy",
      {},
      { type: 123 },
      { type: "exit" },
      { type: "output" },
      { type: "error" },
    ];

    for (const event of malformedEvents) {
      expect(() => nextAgentState("working", event as AgentEvent)).not.toThrow();
      expect(nextAgentState("working", event as AgentEvent)).toBe("working");
    }
  });

  it("converges to a valid state under a 1000-event storm", () => {
    const storm: AgentEvent[] = [];
    const eventTypes: AgentEvent[] = [
      { type: "busy" },
      { type: "prompt" },
      { type: "input" },
      { type: "completion" },
      { type: "output", data: "chunk" },
      { type: "error", error: "ignored" },
      { type: "exit", code: 0 },
      { type: "kill" },
    ];

    for (let i = 0; i < 1000; i++) {
      storm.push(eventTypes[i % eventTypes.length]);
    }

    const finalState = applyEvents("idle", storm);

    expect(["idle", "working", "waiting", "completed", "exited"]).toContain(finalState);
  });

  it("remains deterministic when the same burst is reduced in queued order", async () => {
    const queuedEvents: AgentEvent[] = [
      { type: "start" },
      { type: "busy" },
      { type: "prompt" },
      { type: "input" },
      { type: "completion" },
      { type: "exit", code: 0 },
      { type: "kill" },
    ];

    let sharedState: AgentState = "idle";
    await Promise.all(
      queuedEvents.map(async (event) => {
        sharedState = nextAgentState(sharedState, event);
      })
    );

    expect(sharedState).toBe(applyEvents("idle", queuedEvents));
  });
});
