// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { FleetRunRow, FleetSnapshot } from "@shared/types/ipc/fleet";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import { NEEDS_YOU_BANDS } from "@/lib/fleetAttention";
import { useFleetBandRunIds, useRunFleetBand } from "../useRunFleetBand";

const ask = { kind: "asked", quote: "Ship it?", readAt: 0, seen: false } as const;

function push(runs: Array<Partial<FleetRunRow> & { runId: string }>, changedAt = 0) {
  const snapshot: FleetSnapshot = {
    runs: runs.map((r) => ({ workspaceId: "p1", spawnedAt: 0, cwd: "/repo", ...r })),
    changedAt,
    degraded: false,
    lastSuccessfulAt: null,
  };
  act(() => useFleetSnapshotStore.setState({ snapshot }));
}

afterEach(() => useFleetSnapshotStore.setState({ snapshot: null }));

describe("useRunFleetBand", () => {
  it("reads nothing before the snapshot, then the run's band as it moves", () => {
    const { result } = renderHook(() => useRunFleetBand("t1"));
    expect(result.current).toBeUndefined();

    push([{ runId: "t1", agentState: "waiting", waitingReason: "prompt" }]);
    expect(result.current).toBe("idle");

    push([{ runId: "t1", agentState: "waiting", waitingReason: "question", canopy: ask }]);
    expect(result.current).toBe("needs-you");

    push([{ runId: "other", agentState: "working" }]);
    expect(result.current).toBeUndefined();
  });

  it("doesn't re-render for a push that leaves the run's band alone", () => {
    let renders = 0;
    renderHook(() => {
      renders++;
      return useRunFleetBand("t1");
    });
    push([{ runId: "t1", agentState: "working" }]);
    const settled = renders;
    push([
      { runId: "t1", agentState: "working" },
      { runId: "t2", agentState: "waiting", canopy: ask },
    ]);
    expect(renders).toBe(settled);
  });
});

describe("useFleetBandRunIds", () => {
  it("keeps the same set across pushes that leave membership alone", () => {
    push([{ runId: "t1", agentState: "waiting", canopy: ask }]);
    const { result } = renderHook(() => useFleetBandRunIds(NEEDS_YOU_BANDS));
    const first = result.current;
    expect([...first]).toEqual(["t1"]);

    push([
      { runId: "t1", agentState: "waiting", canopy: ask },
      { runId: "t2", agentState: "working" },
    ]);
    expect(result.current).toBe(first);

    push([{ runId: "t1", agentState: "waiting", canopy: { ...ask, seen: true } }]);
    expect(result.current.size).toBe(0);
  });
});
