import { describe, it, expect } from "vitest";
import type { AgentState, WaitingReason } from "@shared/types/agent";
import type { FleetRunRow, FleetSnapshot, RunCanopyRefinement } from "@shared/types/ipc/fleet";
import { fleetBandForRun, fleetBandRunKey, NEEDS_YOU_BANDS } from "../fleetAttention";
import { isNeedsYouPane, resolvePaneSessionPresentation } from "../paneSessionPresentation";
import { getTerminalAgentDisplayState } from "@/utils/terminalAgentDisplayState";

// What every session glyph off the pane resolves: the snapshot's band for the
// run, the compact display state, and the pane's own observation. These pin
// the chain end to end, from the fleet row a surface never sees.

const NOW = 1_700_000_000_000;
const LIVE_AGENT = { isAgent: true, hasExited: false };

function run(overrides: Partial<FleetRunRow> = {}): FleetRunRow {
  return {
    runId: "t1",
    workspaceId: "p1",
    spawnedAt: NOW - 3_600_000,
    cwd: "/repo",
    ...overrides,
  };
}

function snapshot(runs: FleetRunRow[]): FleetSnapshot {
  return { runs, changedAt: NOW, degraded: false, lastSuccessfulAt: NOW };
}

const seen = { stoppedAt: NOW - 10_000, seenAt: NOW - 5_000 };
const unseen = { stoppedAt: NOW - 10_000 };
const remarked = { stoppedAt: NOW - 10_000, seenAt: NOW - 5_000, markedUnreadAt: NOW - 1_000 };

function canopyAsked(seenAsk: boolean): RunCanopyRefinement {
  return { kind: "asked", quote: "Run the migration?", readAt: NOW - 1_000, seen: seenAsk };
}

/** The glyph a surface draws for `runId`, observing what the fleet row holds. */
function glyph(snap: FleetSnapshot | null, runId: string) {
  const row = snap?.runs.find((r) => r.runId === runId);
  const state: AgentState | undefined = row?.agentState;
  const reason: WaitingReason | undefined = row?.waitingReason;
  return resolvePaneSessionPresentation(
    getTerminalAgentDisplayState(LIVE_AGENT, state),
    fleetBandForRun(snap, runId),
    { agentState: state, waitingReason: reason }
  );
}

describe("session glyphs from the fleet band", () => {
  it("draws nothing for any run before a snapshot is delivered", () => {
    expect(glyph(null, "t1")).toBeUndefined();
    expect(
      resolvePaneSessionPresentation(getTerminalAgentDisplayState(LIVE_AGENT, "waiting"), undefined)
    ).toBeUndefined();
  });

  it("draws a seen prompt stop as finished and an unseen or re-marked one as unread", () => {
    const snap = snapshot([
      run({ runId: "a", agentState: "waiting", handBack: seen }),
      run({ runId: "b", agentState: "waiting", waitingReason: "prompt", handBack: unseen }),
      run({ runId: "c", agentState: "completed", handBack: remarked }),
    ]);
    expect(glyph(snap, "a")).toBe("completed");
    expect(glyph(snap, "b")).toBe("unread");
    expect(glyph(snap, "c")).toBe("unread");
  });

  it("draws nothing for a prompt with no reading and no hand-back on record", () => {
    const snap = snapshot([
      run({ runId: "prompt", agentState: "waiting" }),
      run({ runId: "idle", agentState: "idle" }),
      run({ runId: "nostate" }),
      run({ runId: "finished-unwatched", agentState: "completed" }),
    ]);
    for (const id of ["prompt", "idle", "nostate", "finished-unwatched", "missing"]) {
      expect(glyph(snap, id)).toBeUndefined();
    }
  });

  it("never draws amber for an approval or question wait no reading placed", () => {
    for (const waitingReason of ["approval", "question"] as const) {
      const unseenWait = snapshot([run({ agentState: "waiting", waitingReason })]);
      expect(glyph(unseenWait, "t1")).toBe("unread");
      const seenWait = snapshot([
        run({
          agentState: "waiting",
          waitingReason,
          wait: { stoppedAt: NOW - 5_000, seenAt: NOW },
        }),
      ]);
      expect(glyph(seenWait, "t1")).toBeUndefined();
    }
  });

  it("draws an error wait blocked, with a hand-back on record or not", () => {
    const snap = snapshot([
      run({ runId: "a", agentState: "waiting", waitingReason: "error" }),
      run({ runId: "b", agentState: "waiting", waitingReason: "error", handBack: seen }),
    ]);
    expect(glyph(snap, "a")).toBe("blocked");
    expect(glyph(snap, "b")).toBe("blocked");
  });

  it("draws amber only for an unread Canopy ask, over an older hand-back too", () => {
    const snap = snapshot([
      run({ runId: "ask", agentState: "waiting", canopy: canopyAsked(false) }),
      run({
        runId: "over-handback",
        agentState: "waiting",
        handBack: seen,
        canopy: canopyAsked(false),
      }),
      run({ runId: "finished-turn", agentState: "completed", canopy: canopyAsked(false) }),
      run({ runId: "seen-ask", agentState: "waiting", canopy: canopyAsked(true) }),
    ]);
    expect(glyph(snap, "ask")).toBe("waiting");
    expect(glyph(snap, "over-handback")).toBe("waiting");
    expect(glyph(snap, "finished-turn")).toBe("waiting");
    // A seen ask is still unanswered: no glyph, and never falsely finished.
    expect(glyph(snap, "seen-ask")).toBeUndefined();
  });

  it("keeps live work as observed whatever the band", () => {
    const snap = snapshot([
      run({ runId: "w", agentState: "working", handBack: seen }),
      run({ runId: "d", agentState: "directing" }),
    ]);
    expect(glyph(snap, "w")).toBe("working");
    expect(glyph(snap, "d")).toBe("directing");
  });

  it("never brings back a glyph the display state suppressed", () => {
    const snap = snapshot([run({ agentState: "completed", handBack: unseen })]);
    expect(
      resolvePaneSessionPresentation(
        getTerminalAgentDisplayState({ isAgent: true, hasExited: true }, "completed"),
        fleetBandForRun(snap, "t1")
      )
    ).toBeUndefined();
  });

  it("follows a replaced snapshot rather than a cached one", () => {
    const first = snapshot([run({ agentState: "waiting", handBack: unseen })]);
    expect(glyph(first, "t1")).toBe("unread");
    const second = snapshot([run({ agentState: "waiting", handBack: seen })]);
    expect(glyph(second, "t1")).toBe("completed");
  });
});

describe("waiting counts from the fleet band", () => {
  const needsYou = (snap: FleetSnapshot) =>
    new Set(fleetBandRunKey(snap, NEEDS_YOU_BANDS).split("\n").filter(Boolean));

  it("counts an unread Canopy ask the pane still shows stopped", () => {
    const ids = needsYou(snapshot([run({ agentState: "waiting", canopy: canopyAsked(false) })]));
    for (const agentState of ["waiting", "completed", "idle", undefined] as const) {
      expect(isNeedsYouPane(ids, { id: "t1", agentState })).toBe(true);
    }
  });

  it("counts no prompt, hand-back, observed ask, error wait or seen ask", () => {
    const ids = needsYou(
      snapshot([
        run({ runId: "prompt", agentState: "waiting" }),
        run({ runId: "handback", agentState: "waiting", handBack: unseen }),
        run({ runId: "approval", agentState: "waiting", waitingReason: "approval" }),
        run({ runId: "error", agentState: "waiting", waitingReason: "error" }),
        run({ runId: "seen-ask", agentState: "waiting", canopy: canopyAsked(true) }),
      ])
    );
    expect(ids.size).toBe(0);
    for (const id of ["prompt", "handback", "approval", "error", "seen-ask"]) {
      expect(isNeedsYouPane(ids, { id, agentState: "waiting" })).toBe(false);
    }
  });

  it("drops an ask the pane has moved past before the band catches up", () => {
    const ids = new Set(["t1"]);
    for (const agentState of ["working", "directing", "exited"] as const) {
      expect(isNeedsYouPane(ids, { id: "t1", agentState })).toBe(false);
    }
    expect(isNeedsYouPane(ids, { id: "t1", agentState: "waiting", waitingReason: "error" })).toBe(
      false
    );
    expect(isNeedsYouPane(ids, { id: "t1", agentState: "waiting", isRestarting: true })).toBe(
      false
    );
    expect(isNeedsYouPane(ids, { id: "t1", agentState: "waiting", runtimeStatus: "exited" })).toBe(
      false
    );
  });
});
