// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { create } from "zustand";
import type { FleetRunRow, FleetSnapshot } from "@shared/types/ipc/fleet";
import type { PluginWorktreeAttention } from "@/lib/pluginPanelAttention";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import { EMPTY_WORKTREE_AGENT_BUCKETS } from "@/lib/worktreeAgentBuckets";

const pluginStore = vi.hoisted(() => ({
  current: null as null | (() => ReadonlyMap<string, PluginWorktreeAttention>),
}));
const usePluginAttention = create(() => ({
  byWorktreeId: new Map<string, PluginWorktreeAttention>() as ReadonlyMap<
    string,
    PluginWorktreeAttention
  >,
}));
pluginStore.current = () => usePluginAttention((s) => s.byWorktreeId);

vi.mock("@/hooks/usePluginPanelAttentionRows", () => ({
  usePluginWorktreeAttention: () => pluginStore.current!(),
  readPluginWorktreeAttention: () => new Map(),
}));

import { useWorktreeAgentBuckets } from "../useWorktreeAgentBucketInputs";

function run(runId: string, overrides: Partial<FleetRunRow> = {}): FleetRunRow {
  return { runId, workspaceId: "p1", spawnedAt: 0, cwd: "/repo", ...overrides };
}

function push(runs: FleetRunRow[]): void {
  const snapshot: FleetSnapshot = { runs, changedAt: 1, degraded: false, lastSuccessfulAt: null };
  act(() => useFleetSnapshotStore.getState().applySnapshot(snapshot));
}

function renderCounted(agentPanelIds: readonly string[], worktreeId = "wt-1") {
  let renders = 0;
  const view = renderHook(() => {
    renders++;
    return useWorktreeAgentBuckets(agentPanelIds, false, worktreeId);
  });
  return { view, renders: () => renders };
}

afterEach(() => {
  useFleetSnapshotStore.setState({ snapshot: null });
  usePluginAttention.setState({ byWorktreeId: new Map() });
});

describe("useWorktreeAgentBuckets", () => {
  it("does not re-render when a push changes only another worktree's runs", () => {
    push([run("a", { agentState: "working" }), run("other", { agentState: "working" })]);
    const { view, renders } = renderCounted(["a"]);
    expect(view.result.current.working).toBe(true);
    const before = renders();

    push([run("a", { agentState: "working" }), run("other", { agentState: "waiting" })]);
    push([
      run("a", { agentState: "working" }),
      run("other", { agentState: "idle" }),
      run("new", { agentState: "working" }),
    ]);

    expect(renders()).toBe(before);
  });

  it("re-renders with new buckets when its own run changes", () => {
    push([run("a", { agentState: "working" })]);
    const { view } = renderCounted(["a"]);
    expect(view.result.current).toMatchObject({ working: true, attention: false });

    push([run("a", { agentState: "waiting", waitingReason: "approval" })]);

    expect(view.result.current).toMatchObject({ working: false, attention: true });
  });

  it("keeps the same buckets object across pushes that leave them alone", () => {
    push([run("a", { agentState: "working" })]);
    const { view } = renderCounted(["a"]);
    const first = view.result.current;

    push([run("a", { agentState: "working", title: "renamed" })]);
    view.rerender();

    expect(view.result.current).toBe(first);
  });

  it("contributes nothing for a panel the fleet has not reported", () => {
    push([run("other", { agentState: "working" })]);
    const { view } = renderCounted(["a"]);
    expect(view.result.current).toEqual(EMPTY_WORKTREE_AGENT_BUCKETS);
  });

  it("updates the buckets when plugin attention changes without a fleet push", () => {
    push([]);
    const { view } = renderCounted([], "wt-1");
    expect(view.result.current.attention).toBe(false);

    act(() =>
      usePluginAttention.setState({
        byWorktreeId: new Map([
          ["wt-1", { working: false, attention: true, finished: false, unseen: false }],
        ]),
      })
    );

    expect(view.result.current.attention).toBe(true);
  });

  it("follows a change in its own panel membership", () => {
    push([run("a", { agentState: "working" }), run("b", { agentState: "idle" })]);
    let ids: readonly string[] = ["a"];
    const view = renderHook(() => useWorktreeAgentBuckets(ids, false, "wt-1"));
    expect(view.result.current.working).toBe(true);

    ids = ["b"];
    view.rerender();

    expect(view.result.current.working).toBe(false);
  });
});
