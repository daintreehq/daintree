import { describe, expect, it } from "vitest";
import type { DaintreeEventMap } from "../../../services/events.js";
import { agentStopChangeOf } from "../agentStops.js";

type StateChange = DaintreeEventMap["agent:state-changed"];

const change = (overrides: Partial<StateChange> = {}): StateChange => ({
  terminalId: "t1",
  state: "completed",
  previousState: "working",
  trigger: "heuristic",
  confidence: 0.9,
  timestamp: 1_000,
  ...overrides,
});

function facts(putAside: string[] = []) {
  return {
    getTerminalProjectId: (id: string) => (id === "t1" ? "p1" : null),
    putAside: (id: string) => putAside.includes(id),
  };
}

describe("agentStopChangeOf (#17933)", () => {
  it("reports a turn into completed or exited as a stop, with facts only", () => {
    const stop = agentStopChangeOf(
      change({ agentId: "claude", cwd: "/work/app", exitCode: 0, waitingReason: "prompt" }),
      facts()
    );
    // Nothing of the agent, its folder or its exit leaves the host.
    expect(stop).toEqual({ terminalId: "t1", projectId: "p1", state: "completed", seenAt: 1_000 });
    expect(
      agentStopChangeOf(
        change({ terminalId: "t2", state: "exited", previousState: "waiting" }),
        facts()
      )
    ).toEqual({ terminalId: "t2", projectId: null, state: "exited", seenAt: 1_000 });
  });

  it("keeps completed then exited as the one stop, and ignores repeats and unnamed terminals", () => {
    expect(
      agentStopChangeOf(change({ state: "exited", previousState: "completed" }), facts())
    ).toBe(null);
    expect(agentStopChangeOf(change({ previousState: "completed" }), facts())).toBe(null);
    expect(agentStopChangeOf(change({ terminalId: undefined }), facts())).toBe(null);
  });

  it("takes a stop back when the agent picks up again, waiting included", () => {
    for (const state of ["working", "waiting", "idle", "directing"] as const) {
      expect(agentStopChangeOf(change({ state, previousState: "completed" }), facts())).toEqual({
        terminalId: "t1",
        projectId: "p1",
        state: null,
        seenAt: 1_000,
      });
    }
    expect(
      agentStopChangeOf(change({ state: "working", previousState: "exited" }), facts())
    ).toEqual(expect.objectContaining({ state: null }));
  });

  it("says nothing of work turns no stop came before", () => {
    expect(agentStopChangeOf(change({ state: "waiting", previousState: "working" }), facts())).toBe(
      null
    );
    expect(agentStopChangeOf(change({ state: "working", previousState: "idle" }), facts())).toBe(
      null
    );
  });

  it("never reports Daintree closing a terminal as a stop, and takes back any it had", () => {
    expect(agentStopChangeOf(change({ state: "exited", terminalClosing: true }), facts())).toEqual(
      expect.objectContaining({ terminalId: "t1", state: null })
    );
    expect(
      agentStopChangeOf(
        change({ state: "exited", previousState: "completed", terminalClosing: true }),
        facts()
      )
    ).toEqual(expect.objectContaining({ state: null }));
  });

  it("leaves out a run put aside here", () => {
    expect(agentStopChangeOf(change(), facts(["t1"]))).toBe(null);
    // Its agent picking up again still takes back whatever was sent before it was put aside.
    expect(
      agentStopChangeOf(change({ state: "working", previousState: "completed" }), facts(["t1"]))
    ).toEqual(expect.objectContaining({ state: null }));
  });
});
