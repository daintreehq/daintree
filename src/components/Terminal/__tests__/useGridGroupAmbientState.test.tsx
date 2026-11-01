// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { FleetRunRow } from "@shared/types/ipc/fleet";
import type { PtyPanelData } from "@shared/types/panel";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import { useGridGroupAmbientState } from "../useGridGroupAmbientState";

const ask = { kind: "asked", quote: "Ship it?", readAt: 0, seen: false } as const;

function fleet(runs: Array<Partial<FleetRunRow> & { runId: string }>) {
  act(() =>
    useFleetSnapshotStore.setState({
      snapshot: {
        runs: runs.map((r) => ({ workspaceId: "p1", spawnedAt: 0, cwd: "/repo", ...r })),
        changedAt: 0,
        degraded: false,
        lastSuccessfulAt: null,
      },
    })
  );
}

function tab(id: string, fields: Partial<PtyPanelData> = {}): PtyPanelData {
  return {
    id,
    kind: "terminal",
    title: id,
    location: "grid",
    cols: 80,
    rows: 24,
    cwd: "/repo",
    ...fields,
  };
}

afterEach(() => {
  cleanup();
  useFleetSnapshotStore.setState({ snapshot: null });
});

describe("useGridGroupAmbientState", () => {
  const panels = [
    tab("shown", { agentState: "waiting", waitingReason: "prompt" }),
    tab("hidden", { agentState: "waiting", waitingReason: "question" }),
  ];

  it("waits for a hidden tab's unread ask, and lets it go once seen", () => {
    fleet([
      { runId: "shown", agentState: "waiting", waitingReason: "prompt" },
      { runId: "hidden", agentState: "waiting", waitingReason: "question", canopy: ask },
    ]);
    const { result } = renderHook(() => useGridGroupAmbientState(panels, "shown"));
    expect(result.current).toBe("waiting");

    fleet([
      { runId: "shown", agentState: "waiting", waitingReason: "prompt" },
      {
        runId: "hidden",
        agentState: "waiting",
        waitingReason: "question",
        canopy: { ...ask, seen: true },
      },
    ]);
    expect(result.current).toBeUndefined();
  });

  it("hands the ask to the pane once its tab is the one shown", () => {
    fleet([{ runId: "hidden", agentState: "waiting", waitingReason: "question", canopy: ask }]);
    const { result, rerender } = renderHook(
      ({ active }) => useGridGroupAmbientState(panels, active),
      {
        initialProps: { active: "shown" },
      }
    );
    expect(result.current).toBe("waiting");

    rerender({ active: "hidden" });
    expect(result.current).toBeUndefined();
  });

  it("raises nothing for a prompt, a hand-back, or before the fleet has reported", () => {
    const { result } = renderHook(() => useGridGroupAmbientState(panels, "shown"));
    expect(result.current).toBeUndefined();

    fleet([
      { runId: "shown", agentState: "waiting", waitingReason: "prompt" },
      { runId: "hidden", agentState: "completed", handBack: { stoppedAt: 0 } },
    ]);
    expect(result.current).toBeUndefined();
  });

  it("drops a hidden ask whose tab is restarting or has exited", () => {
    fleet([{ runId: "hidden", agentState: "waiting", waitingReason: "question", canopy: ask }]);
    const staleFields: Partial<PtyPanelData>[] = [
      { isRestarting: true },
      { exitCode: 0 },
      { runtimeStatus: "exited" },
    ];
    for (const fields of staleFields) {
      const stale = [panels[0]!, tab("hidden", { agentState: "waiting", ...fields })];
      const { result, unmount } = renderHook(() => useGridGroupAmbientState(stale, "shown"));
      expect(result.current, JSON.stringify(fields)).toBeUndefined();
      unmount();
    }
  });
});
