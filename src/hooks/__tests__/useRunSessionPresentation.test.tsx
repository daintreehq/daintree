// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { FleetRunRow, FleetSnapshot } from "@shared/types/ipc/fleet";
import type { AgentState, WaitingReason } from "@shared/types/agent";
import type { PtyPanelData } from "@shared/types/panel";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import { usePanelStore } from "@/store/panelStore";
import { useRunFleetBands, useRunSessionPresentation } from "../useRunSessionPresentation";

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

/** The pane's own record of its run, as the panel store holds it. */
function observe(
  id: string,
  observation: {
    agentState?: AgentState;
    waitingReason?: WaitingReason;
    isRestarting?: boolean;
    runtimeStatus?: PtyPanelData["runtimeStatus"];
  }
) {
  const panel = {
    id,
    kind: "terminal",
    title: "Claude",
    location: "grid",
    cwd: "/repo",
    cols: 80,
    rows: 24,
    launchAgentId: "claude",
    ...observation,
  } as PtyPanelData;
  act(() =>
    usePanelStore.setState((s) => ({
      panelsById: { ...s.panelsById, [id]: panel },
      panelIds: s.panelIds.includes(id) ? s.panelIds : [...s.panelIds, id],
    }))
  );
}

afterEach(() => {
  cleanup();
  useFleetSnapshotStore.setState({ snapshot: null });
  usePanelStore.setState({ panelsById: {}, panelIds: [] });
});

describe("useRunSessionPresentation", () => {
  it("draws a quiet live agent by its band: nothing, amber, unread, finished, blocked", () => {
    observe("t1", { agentState: "waiting" });
    const { result } = renderHook(() => useRunSessionPresentation("t1", "waiting"));
    // No report yet, then a prompt that asks nothing.
    expect(result.current).toBeUndefined();
    push([{ runId: "t1", agentState: "waiting" }]);
    expect(result.current).toBeUndefined();

    push([{ runId: "t1", agentState: "waiting", canopy: ask }]);
    expect(result.current).toBe("waiting");
    push([{ runId: "t1", agentState: "waiting", handBack: { stoppedAt: 1 } }]);
    expect(result.current).toBe("unread");
    push([{ runId: "t1", agentState: "waiting", handBack: { stoppedAt: 1, seenAt: 2 } }]);
    expect(result.current).toBe("completed");
    push([{ runId: "t1", agentState: "waiting", waitingReason: "error" }]);
    expect(result.current).toBe("blocked");
  });

  it("drops amber the moment the pane moves past the ask, before the band does", () => {
    observe("t1", { agentState: "waiting" });
    push([{ runId: "t1", agentState: "waiting", canopy: ask }]);
    const { result } = renderHook(() => useRunSessionPresentation("t1", "waiting"));
    expect(result.current).toBe("waiting");

    observe("t1", { agentState: "waiting", isRestarting: true });
    expect(result.current).toBeUndefined();
    observe("t1", { agentState: "waiting", runtimeStatus: "exited" });
    expect(result.current).toBeUndefined();
    observe("t1", { agentState: "waiting", waitingReason: "error" });
    expect(result.current).toBeUndefined();
    observe("t1", { agentState: "completed" });
    expect(result.current).toBe("waiting");
  });

  it("keeps live work and a suppressed glyph as the display state has them", () => {
    push([{ runId: "t1", agentState: "waiting", canopy: ask }]);
    expect(renderHook(() => useRunSessionPresentation("t1", "working")).result.current).toBe(
      "working"
    );
    expect(
      renderHook(() => useRunSessionPresentation("t1", undefined)).result.current
    ).toBeUndefined();
  });
});

describe("useRunFleetBands", () => {
  it("reads each terminal's band in order, undefined where the fleet holds no run", () => {
    const { result } = renderHook(() => useRunFleetBands(["b", "missing", "a"]));
    expect(result.current).toEqual([undefined, undefined, undefined]);

    push([
      { runId: "a", agentState: "working" },
      { runId: "b", agentState: "waiting", canopy: ask },
    ]);
    expect(result.current).toEqual(["needs-you", undefined, "running"]);
  });

  it("re-renders only when one of its runs changes band", () => {
    let renders = 0;
    const { result } = renderHook(() => {
      renders++;
      return useRunFleetBands(["a"]);
    });
    push([{ runId: "a", agentState: "working" }]);
    const settled = renders;
    const before = result.current;

    push([
      { runId: "a", agentState: "working" },
      { runId: "other", agentState: "waiting", canopy: ask },
    ]);
    expect(renders).toBe(settled);
    expect(result.current).toBe(before);

    push([{ runId: "a", agentState: "waiting", canopy: ask }]);
    expect(result.current).toEqual(["needs-you"]);
  });
});
