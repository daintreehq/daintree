import { describe, expect, it } from "vitest";
import type { WorktreeSnapshot } from "../../../shared/types/workspace-host.js";
import { WorktreeEmitGate } from "../WorktreeEmitGate.js";

function snap(extra: Partial<WorktreeSnapshot> = {}): WorktreeSnapshot {
  return {
    id: "/repo/wt",
    worktreeId: "/repo/wt",
    generation: 1,
    path: "/repo/wt",
    name: "wt",
    modifiedCount: 1,
    timestamp: 1,
    lastGitStatusCheckedAt: 1,
    ...extra,
  } as WorktreeSnapshot;
}

describe("WorktreeEmitGate", () => {
  it("sends the first snapshot whole and a stamp-only successor as a tick", () => {
    const gate = new WorktreeEmitGate();
    const monitor = {};
    expect(gate.next(monitor, snap())).toBeNull();

    const tick = gate.next(
      monitor,
      snap({ timestamp: 2, lastGitStatusCheckedAt: 2, workingTreeChangedAt: 5 })
    );
    expect(tick).toMatchObject({
      worktreeId: "/repo/wt",
      path: "/repo/wt",
      generation: 1,
      timestamp: 2,
      lastGitStatusCheckedAt: 2,
      workingTreeChangedAt: 5,
    });
  });

  it("sends a content change whole and compares later ticks against it", () => {
    const gate = new WorktreeEmitGate();
    const monitor = {};
    gate.next(monitor, snap());
    expect(gate.next(monitor, snap({ modifiedCount: 2 }))).toBeNull();
    expect(gate.next(monitor, snap({ modifiedCount: 2, timestamp: 3 }))).not.toBeNull();
    // Reverting to the first content is a change relative to the last sent.
    expect(gate.next(monitor, snap({ timestamp: 4 }))).toBeNull();
  });

  it("keys by monitor, so a new incarnation at the same path starts whole", () => {
    const gate = new WorktreeEmitGate();
    gate.next({}, snap());
    expect(gate.next({}, snap())).toBeNull();
  });

  it("forces the next emit whole after a divergent out-of-band snapshot", () => {
    const gate = new WorktreeEmitGate();
    const monitor = {};
    gate.next(monitor, snap());
    // Hydration handed a consumer content the others never saw.
    gate.noteOutOfBand(monitor, snap({ modifiedCount: 9 }));
    expect(gate.next(monitor, snap({ timestamp: 5 }))).toBeNull();
  });

  it("keeps ticking after an out-of-band snapshot that matches what was sent", () => {
    const gate = new WorktreeEmitGate();
    const monitor = {};
    gate.next(monitor, snap());
    gate.noteOutOfBand(monitor, snap({ timestamp: 7 }));
    expect(gate.next(monitor, snap({ timestamp: 8 }))).not.toBeNull();
  });

  it("starts every monitor whole again after reset", () => {
    const gate = new WorktreeEmitGate();
    const a = {};
    const b = {};
    gate.next(a, snap());
    gate.next(b, snap());
    gate.reset();
    expect(gate.next(a, snap({ timestamp: 2 }))).toBeNull();
    expect(gate.next(b, snap({ timestamp: 2 }))).toBeNull();
    expect(gate.next(a, snap({ timestamp: 3 }))).not.toBeNull();
  });

  it("starts whole again after forget", () => {
    const gate = new WorktreeEmitGate();
    const monitor = {};
    gate.next(monitor, snap());
    gate.forget(monitor);
    expect(gate.next(monitor, snap({ timestamp: 2 }))).toBeNull();
  });
});
