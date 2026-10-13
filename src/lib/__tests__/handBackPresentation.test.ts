import { describe, it, expect } from "vitest";
import type { FleetRunRow, FleetSnapshot } from "@shared/types/ipc/fleet";
import {
  handBackRunKey,
  handBackStateForRun,
  isAskingWait,
  isHandBackWait,
  resolveSessionPresentation,
} from "../handBackPresentation";

const NOW = 1_700_000_000_000;

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

describe("handBackStateForRun", () => {
  it("reads a snapshot not yet delivered as no hand-back", () => {
    expect(handBackStateForRun(null, "t1")).toBe("none");
  });

  it("reads seen, unseen and marked-unread records off a prompt stop", () => {
    const snap = snapshot([
      run({ runId: "a", agentState: "waiting", handBack: seen }),
      run({ runId: "b", agentState: "waiting", waitingReason: "prompt", handBack: unseen }),
      run({ runId: "c", agentState: "completed", handBack: remarked }),
    ]);
    expect(handBackStateForRun(snap, "a")).toBe("seen");
    expect(handBackStateForRun(snap, "b")).toBe("unseen");
    expect(handBackStateForRun(snap, "c")).toBe("unseen");
  });

  it("ignores runs with no record, or whose observed stop is not a hand-back", () => {
    const snap = snapshot([
      run({ runId: "none", agentState: "waiting" }),
      run({ runId: "approval", agentState: "waiting", waitingReason: "approval", handBack: seen }),
      run({ runId: "working", agentState: "working", handBack: seen }),
      run({ runId: "nostate", handBack: seen }),
    ]);
    for (const id of ["none", "approval", "working", "nostate", "missing"]) {
      expect(handBackStateForRun(snap, id)).toBe("none");
    }
  });

  it("follows a replaced snapshot rather than a cached one", () => {
    const first = snapshot([run({ agentState: "waiting", handBack: unseen })]);
    expect(handBackStateForRun(first, "t1")).toBe("unseen");
    const second = snapshot([run({ agentState: "waiting", handBack: seen })]);
    expect(handBackStateForRun(second, "t1")).toBe("seen");
  });
});

describe("resolveSessionPresentation", () => {
  it("draws a seen prompt stop as completed and an unseen one as unread", () => {
    expect(resolveSessionPresentation("waiting", "waiting", undefined, "seen")).toBe("completed");
    expect(resolveSessionPresentation("waiting", "waiting", "prompt", "unseen")).toBe("unread");
    expect(resolveSessionPresentation("waiting", "completed", undefined, "seen")).toBe("completed");
  });

  it("keeps the amber circle for approval, question and error waits", () => {
    for (const reason of ["approval", "question", "error"] as const) {
      expect(resolveSessionPresentation("waiting", "waiting", reason, "seen")).toBe("waiting");
      expect(resolveSessionPresentation("waiting", "waiting", reason, "unseen")).toBe("waiting");
    }
  });

  it("leaves the display state alone without a hand-back or a raw stop", () => {
    expect(resolveSessionPresentation("waiting", "waiting", undefined, "none")).toBe("waiting");
    // Idle coerced to waiting by the display helper is not a hand-back stop.
    expect(resolveSessionPresentation("waiting", "idle", undefined, "seen")).toBe("waiting");
    expect(resolveSessionPresentation("waiting", undefined, undefined, "seen")).toBe("waiting");
    expect(resolveSessionPresentation("working", "working", undefined, "seen")).toBe("working");
  });

  it("never brings back a glyph the display state suppressed", () => {
    expect(resolveSessionPresentation(undefined, "completed", undefined, "seen")).toBeUndefined();
  });
});

describe("handBackRunKey", () => {
  it("lists every hand-back run, seen or not, in a stable order", () => {
    const snap = snapshot([
      run({ runId: "b", agentState: "waiting", handBack: seen }),
      run({ runId: "a", agentState: "completed", handBack: unseen }),
      run({ runId: "approval", agentState: "waiting", waitingReason: "approval", handBack: seen }),
      run({ runId: "none", agentState: "waiting" }),
    ]);
    expect(handBackRunKey(snap).split("\n")).toEqual(["a", "b"]);
  });

  it("is empty before a snapshot arrives, and equal across snapshots with the same set", () => {
    expect(handBackRunKey(null)).toBe("");
    const first = snapshot([run({ agentState: "waiting", handBack: unseen })]);
    const second = snapshot([run({ agentState: "waiting", handBack: seen })]);
    expect(handBackRunKey(first)).toBe(handBackRunKey(second));
  });
});

describe("isHandBackWait / isAskingWait", () => {
  const ids = new Set(["t1"]);

  it("treats a prompt wait the fleet holds a hand-back for as no wait", () => {
    for (const waitingReason of [undefined, "prompt"] as const) {
      const panel = { id: "t1", agentState: "waiting" as const, waitingReason };
      expect(isHandBackWait(ids, panel)).toBe(true);
      expect(isAskingWait(ids, panel)).toBe(false);
    }
  });

  it("keeps an approval, question or error wait asking even with a record", () => {
    for (const waitingReason of ["approval", "question", "error"] as const) {
      const panel = { id: "t1", agentState: "waiting" as const, waitingReason };
      expect(isHandBackWait(ids, panel)).toBe(false);
      expect(isAskingWait(ids, panel)).toBe(true);
    }
  });

  it("keeps a prompt wait with no hand-back record asking", () => {
    const panel = { id: "other", agentState: "waiting" as const };
    expect(isAskingWait(ids, panel)).toBe(true);
  });

  it("never calls a state other than waiting a wait", () => {
    for (const agentState of ["working", "completed", "idle", "exited", "directing"] as const) {
      expect(isAskingWait(ids, { id: "t1", agentState })).toBe(false);
      expect(isHandBackWait(ids, { id: "t1", agentState })).toBe(false);
    }
  });
});
