// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { FleetRunRow } from "@shared/types/ipc/fleet";
import type { BrowserPanelData, PanelInstance, PtyPanelData } from "@shared/types/panel";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import {
  _resetPanelFailureStoreForTest,
  observePanelFailures,
  usePanelFailureStore,
} from "@/store/panelFailureStore";
import { useGridGroupAmbientState, useGridGroupHiddenFailure } from "../useGridGroupAmbientState";

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
  _resetPanelFailureStoreForTest();
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

  it.each(["approval", "question"] as const)(
    "waits for a hidden tab's observed %s wait without Canopy until the look marks it seen",
    (waitingReason) => {
      const tabs = [
        tab("shown", { agentState: "waiting", waitingReason: "prompt" }),
        tab("hidden", { agentState: "waiting", waitingReason }),
      ];
      const hidden = (wait: FleetRunRow["wait"]) =>
        fleet([
          { runId: "shown", agentState: "waiting", waitingReason: "prompt" },
          { runId: "hidden", agentState: "waiting", waitingReason, wait },
        ]);
      hidden({ stoppedAt: 0 });
      const { result } = renderHook(() => useGridGroupAmbientState(tabs, "shown"));
      expect(result.current).toBe("waiting");

      hidden({ stoppedAt: 0, seenAt: 1 });
      expect(result.current).toBeUndefined();

      // A new ask is a new wait, unseen again.
      hidden({ stoppedAt: 5 });
      expect(result.current).toBe("waiting");
    }
  );

  it("raises nothing for a hidden tab at its prompt", () => {
    const tabs = [
      tab("shown", { agentState: "working" }),
      tab("hidden", { agentState: "waiting", waitingReason: "prompt" }),
    ];
    fleet([
      { runId: "shown", agentState: "working" },
      { runId: "hidden", agentState: "waiting", waitingReason: "prompt" },
    ]);
    const { result } = renderHook(() => useGridGroupAmbientState(tabs, "shown"));
    expect(result.current).toBe("working");
  });

  it("drops a hidden observed ask once its tab has moved on before the fleet catches up", () => {
    fleet([{ runId: "hidden", agentState: "waiting", waitingReason: "question" }]);
    for (const fields of [
      { agentState: "waiting", waitingReason: "prompt" },
      { agentState: "completed" },
    ] as const) {
      const moved = [panels[0]!, tab("hidden", fields)];
      const { result, unmount } = renderHook(() => useGridGroupAmbientState(moved, "shown"));
      expect(result.current, JSON.stringify(fields)).toBeUndefined();
      unmount();
    }
  });

  it("lets Canopy's reading decide: a hidden question it read as asking nothing raises nothing", () => {
    fleet([
      {
        runId: "hidden",
        agentState: "waiting",
        waitingReason: "question",
        canopy: { kind: "not-asking", quote: "Done.", readAt: 0, seen: false },
      },
    ]);
    const { result } = renderHook(() => useGridGroupAmbientState(panels, "shown"));
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
      { runtimeStatus: "exited" },
      { agentState: "exited" },
    ];
    for (const fields of staleFields) {
      const stale = [panels[0]!, tab("hidden", { agentState: "waiting", ...fields })];
      const { result, unmount } = renderHook(() => useGridGroupAmbientState(stale, "shown"));
      expect(result.current, JSON.stringify(fields)).toBeUndefined();
      unmount();
    }
  });
});

describe("useGridGroupHiddenFailure", () => {
  const browser: BrowserPanelData = {
    id: "shown",
    kind: "browser",
    title: "Docs",
    location: "grid",
    browserUrl: "https://example.com",
  };

  /** Every panel record write reaches the failure store, as the orchestrator does. */
  function records(panels: readonly PanelInstance[]) {
    act(() => observePanelFailures(Object.fromEntries(panels.map((p) => [p.id, p]))));
  }

  function lookAt(panelId: string) {
    const occurrences = usePanelFailureStore.getState().occurrences[panelId] ?? {};
    const tokens = Object.fromEntries(
      Object.entries(occurrences).map(([source, occurrence]) => [source, occurrence!.token])
    );
    act(() => usePanelFailureStore.getState().markSeen(panelId, tokens));
  }

  const failures: Array<[string, Partial<PtyPanelData>]> = [
    ["an error wait", { agentState: "waiting", waitingReason: "error" }],
    ["a failed exit", { runtimeStatus: "exited", exitCode: 1 }],
    ["a failed spawn", { spawnError: { code: "ENOENT", message: "not found" } }],
    ["a failed restart", { restartError: { message: "no", timestamp: 1, recoverable: false } }],
    [
      "a failed reconnect",
      { reconnectError: { message: "gone", timestamp: 1, type: "not_found" } },
    ],
  ];

  it.each(failures)("raises %s on a hidden tab until its own look marks it seen", (_, fields) => {
    const panels = [browser, tab("hidden", { launchAgentId: "claude", ...fields })];
    records(panels);
    const { result } = renderHook(() => useGridGroupHiddenFailure(panels, "shown"));
    expect(result.current).toBe(true);

    lookAt("hidden");
    expect(result.current).toBe(false);
  });

  it("raises a failure again once it clears and comes back", () => {
    const failed = tab("hidden", { runtimeStatus: "exited", exitCode: 1 });
    records([browser, failed]);
    const { result, rerender } = renderHook(
      ({ panels }) => useGridGroupHiddenFailure(panels, "shown"),
      { initialProps: { panels: [browser, failed] as PanelInstance[] } }
    );
    lookAt("hidden");
    expect(result.current).toBe(false);

    const restarted = tab("hidden", { agentState: "working" });
    records([browser, restarted]);
    rerender({ panels: [browser, restarted] });
    expect(result.current).toBe(false);

    const failedAgain = tab("hidden", { runtimeStatus: "exited", exitCode: 2 });
    records([browser, failedAgain]);
    rerender({ panels: [browser, failedAgain] });
    expect(result.current).toBe(true);
  });

  it("raises a replaced restart error while the old one stays seen", () => {
    const first = tab("hidden", {
      restartError: { message: "no", timestamp: 1, recoverable: false },
    });
    records([browser, first]);
    const { result, rerender } = renderHook(
      ({ panels }) => useGridGroupHiddenFailure(panels, "shown"),
      { initialProps: { panels: [browser, first] as PanelInstance[] } }
    );
    lookAt("hidden");
    expect(result.current).toBe(false);

    const second = tab("hidden", {
      restartError: { message: "no", timestamp: 2, recoverable: false },
    });
    records([browser, second]);
    rerender({ panels: [browser, second] });
    expect(result.current).toBe(true);
  });

  it("keeps raising while one of two failures is still unseen", () => {
    const exited = tab("hidden", { runtimeStatus: "exited", exitCode: 1 });
    records([browser, exited]);
    lookAt("hidden");
    const both = tab("hidden", {
      runtimeStatus: "exited",
      exitCode: 1,
      restartError: { message: "no", timestamp: 3, recoverable: false },
    });
    records([browser, both]);
    const { result } = renderHook(() => useGridGroupHiddenFailure([browser, both], "shown"));
    expect(result.current).toBe(true);
  });

  it("counts a plain shell's failed exit, but not a clean or interrupted one", () => {
    for (const [exitCode, failed] of [
      [1, true],
      [0, false],
      [130, false],
    ] as const) {
      _resetPanelFailureStoreForTest();
      const panels = [browser, tab("hidden", { runtimeStatus: "exited", exitCode })];
      records(panels);
      const { result, unmount } = renderHook(() => useGridGroupHiddenFailure(panels, "shown"));
      expect(result.current, `exit ${exitCode}`).toBe(failed);
      unmount();
    }
  });

  it("raises nothing for a reconnect timeout or a failed submit", () => {
    const panels = [
      browser,
      tab("hidden", { reconnectError: { message: "slow", timestamp: 1, type: "timeout" } }),
    ];
    records(panels);
    // Only a mounted pane sees a submit fail, and its record outlives the failure.
    act(() => usePanelFailureStore.getState().noteSubmitFailure("hidden"));
    const { result } = renderHook(() => useGridGroupHiddenFailure(panels, "shown"));
    expect(result.current).toBe(false);
  });

  it("leaves the shown tab's failure to its own pane, and hands a hidden one over once shown", () => {
    const panels = [
      tab("shown", { runtimeStatus: "exited", exitCode: 1 }),
      tab("hidden", { spawnError: { code: "ENOENT", message: "not found" } }),
    ];
    records(panels);
    const { result, rerender } = renderHook(
      ({ active }) => useGridGroupHiddenFailure(panels, active),
      { initialProps: { active: "shown" } }
    );
    expect(result.current).toBe(true);

    lookAt("hidden");
    expect(result.current).toBe(false);

    rerender({ active: "hidden" });
    // Now the failed exit is the hidden one.
    expect(result.current).toBe(true);
  });
});
