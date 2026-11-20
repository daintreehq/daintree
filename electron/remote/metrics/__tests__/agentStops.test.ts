import { describe, expect, it } from "vitest";
import type { DaintreeEventMap } from "../../../services/events.js";
import { agentStopChangeOf } from "../agentStops.js";
import { MAX_METRICS_ID_CHARS } from "../linkMethods.js";

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

function facts(putAside: string[] = [], projectId: string | null = "p1") {
  return {
    getTerminalProjectId: (id: string) => (id === "t1" ? projectId : null),
    putAside: (id: string) => putAside.includes(id),
  };
}

const takenBack = (overrides: Partial<StateChange> = {}) =>
  agentStopChangeOf(change(overrides), facts());

describe("agentStopChangeOf (#17933)", () => {
  it("reports a turn into completed or exited as a stop, with facts only", () => {
    const stop = agentStopChangeOf(
      change({
        agentId: "claude",
        cwd: "/work/app",
        exitCode: 0,
        waitingReason: "prompt",
        timestamp: 4_321,
      }),
      facts()
    );
    // Nothing of the agent, its folder or its exit leaves the host.
    expect(stop).toEqual({
      terminalId: "t1",
      projectId: "p1",
      stopped: true,
      state: "completed",
      seenAt: 4_321,
    });
    expect(
      agentStopChangeOf(
        change({ terminalId: "t2", state: "exited", previousState: "waiting" }),
        facts()
      )
    ).toEqual({ terminalId: "t2", projectId: null, stopped: true, state: "exited", seenAt: 1_000 });
  });

  it("keeps completed then exited as the one stop, and ignores repeats and unnamed terminals", () => {
    expect(takenBack({ state: "exited", previousState: "completed" })).toBe(null);
    expect(takenBack({ previousState: "completed" })).toBe(null);
    expect(takenBack({ terminalId: undefined })).toBe(null);
    // A repeat of a working state, which would otherwise read as a turn out of idle.
    expect(takenBack({ state: "idle", previousState: "idle" })).toBe(null);
  });

  it("takes a stop back when the agent picks up again, waiting included", () => {
    for (const state of ["working", "waiting", "idle", "directing"] as const) {
      expect(takenBack({ state, previousState: "completed", timestamp: 2_000 })).toEqual({
        terminalId: "t1",
        projectId: "p1",
        stopped: false,
        state: null,
        seenAt: 2_000,
      });
    }
    expect(takenBack({ state: "working", previousState: "exited" })).toEqual(
      expect.objectContaining({ projectId: "p1", stopped: false })
    );
  });

  it("takes back a stop when its terminal starts again from idle, as after a respawn", () => {
    expect(takenBack({ state: "working", previousState: "idle" })).toEqual(
      expect.objectContaining({ stopped: false, state: null })
    );
  });

  it("says nothing of work turns no stop came before", () => {
    for (const [state, previousState] of [
      ["waiting", "working"],
      ["working", "waiting"],
      ["directing", "working"],
      ["working", "directing"],
      ["idle", "working"],
    ] as const) {
      expect(takenBack({ state, previousState }), `${previousState} → ${state}`).toBe(null);
    }
  });

  it("never reports Daintree closing a terminal as a stop, and takes back any it had", () => {
    expect(takenBack({ state: "exited", terminalClosing: true })).toEqual(
      expect.objectContaining({ terminalId: "t1", stopped: false, state: null })
    );
    expect(
      takenBack({ state: "exited", previousState: "completed", terminalClosing: true })
    ).toEqual(expect.objectContaining({ stopped: false }));
    // A close while it worked still takes back whatever came before.
    expect(takenBack({ state: "waiting", terminalClosing: true })).toEqual(
      expect.objectContaining({ stopped: false })
    );
  });

  it("leaves out a run put aside here, whichever way it stops", () => {
    expect(agentStopChangeOf(change(), facts(["t1"]))).toBe(null);
    expect(agentStopChangeOf(change({ state: "exited" }), facts(["t1"]))).toBe(null);
    // Its agent picking up again still takes back whatever was sent before it was put aside.
    expect(
      agentStopChangeOf(change({ state: "working", previousState: "completed" }), facts(["t1"]))
    ).toEqual(expect.objectContaining({ stopped: false }));
  });

  it("sends nothing for a terminal id the link can't carry, and no project id it can't", () => {
    const long = "x".repeat(MAX_METRICS_ID_CHARS + 1);
    expect(takenBack({ terminalId: long })).toBe(null);
    expect(agentStopChangeOf(change(), facts([], long))).toEqual(
      expect.objectContaining({ terminalId: "t1", projectId: null, stopped: true })
    );
  });
});
