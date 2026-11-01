// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { create } from "zustand";
import type { FleetRunRow, FleetSnapshot } from "@shared/types/ipc/fleet";
import type { PluginWorktreeAttention } from "@/lib/pluginPanelAttention";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import { EMPTY_WORKTREE_AGENT_BUCKETS } from "@/lib/worktreeAgentBuckets";

// Plugin attention changes apart from the fleet, so it gets its own store here.
vi.mock("@/hooks/usePluginPanelAttentionRows", () => ({
  usePluginWorktreeAttention: usePluginAttentionMap,
  readPluginWorktreeAttention: () => new Map(),
}));

import { useWorktreeAgentBuckets } from "../useWorktreeAgentBucketInputs";

const usePluginAttention = create(() => ({
  byWorktreeId: new Map() as ReadonlyMap<string, PluginWorktreeAttention>,
}));

function usePluginAttentionMap(): ReadonlyMap<string, PluginWorktreeAttention> {
  return usePluginAttention((s) => s.byWorktreeId);
}

function setPluginAttention(entries: Array<[string, Partial<PluginWorktreeAttention>]>): void {
  const none = { working: false, attention: false, finished: false, unseen: false };
  act(() =>
    usePluginAttention.setState({
      byWorktreeId: new Map(entries.map(([id, facts]) => [id, { ...none, ...facts }])),
    })
  );
}

function run(runId: string, overrides: Partial<FleetRunRow> = {}): FleetRunRow {
  return { runId, workspaceId: "p1", spawnedAt: 0, cwd: "/repo", ...overrides };
}

function push(runs: FleetRunRow[]): void {
  const snapshot: FleetSnapshot = { runs, changedAt: 1, degraded: false, lastSuccessfulAt: null };
  act(() => useFleetSnapshotStore.getState().applySnapshot(snapshot));
}

interface HookProps {
  ids: readonly string[];
  merged: boolean;
  worktreeId: string;
}

function renderCounted(initialProps: HookProps) {
  let renders = 0;
  const view = renderHook(
    ({ ids, merged, worktreeId }: HookProps) => {
      renders++;
      return useWorktreeAgentBuckets(ids, merged, worktreeId);
    },
    { initialProps }
  );
  return { view, renders: () => renders };
}

afterEach(() => {
  act(() => {
    useFleetSnapshotStore.setState({ snapshot: null });
    usePluginAttention.setState({ byWorktreeId: new Map() });
  });
});

describe("useWorktreeAgentBuckets", () => {
  it("does not re-render when a push changes only another worktree's runs", () => {
    push([run("a", { agentState: "working" }), run("other", { agentState: "working" })]);
    const { view, renders } = renderCounted({ ids: ["a"], merged: false, worktreeId: "wt-1" });
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
    const { view } = renderCounted({ ids: ["a"], merged: false, worktreeId: "wt-1" });
    expect(view.result.current).toMatchObject({ working: true, attention: false });

    push([
      run("a", {
        agentState: "waiting",
        waitingReason: "approval",
        canopy: { kind: "asked", quote: "Run the migration?", readAt: 1, seen: false },
      }),
    ]);

    expect(view.result.current).toMatchObject({ working: false, attention: true });
  });

  it("keeps the same buckets object across pushes that leave them alone", () => {
    push([run("a", { agentState: "working" })]);
    const { view, renders } = renderCounted({ ids: ["a"], merged: false, worktreeId: "wt-1" });
    const first = view.result.current;
    const before = renders();

    push([run("a", { agentState: "working", title: "renamed" })]);

    expect(renders()).toBe(before);
    view.rerender({ ids: ["a"], merged: false, worktreeId: "wt-1" });
    expect(view.result.current).toBe(first);
  });

  it("contributes nothing for a panel the fleet has not reported", () => {
    push([run("other", { agentState: "working" })]);
    const { view } = renderCounted({ ids: ["a"], merged: false, worktreeId: "wt-1" });
    expect(view.result.current).toEqual(EMPTY_WORKTREE_AGENT_BUCKETS);
  });

  it("follows plugin attention for its own worktree without a fleet push", () => {
    push([]);
    const { view } = renderCounted({ ids: [], merged: false, worktreeId: "wt-1" });
    expect(view.result.current.attention).toBe(false);

    setPluginAttention([["wt-1", { attention: true }]]);
    expect(view.result.current.attention).toBe(true);

    setPluginAttention([["wt-1", {}]]);
    expect(view.result.current.attention).toBe(false);
  });

  it("follows a change in its own panel membership without a fleet push", () => {
    push([
      run("a", { agentState: "working" }),
      run("b", {
        agentState: "waiting",
        waitingReason: "approval",
        canopy: { kind: "asked", quote: "Run the migration?", readAt: 1, seen: false },
      }),
    ]);
    const { view } = renderCounted({ ids: ["a"], merged: false, worktreeId: "wt-1" });
    expect(view.result.current).toMatchObject({ working: true, attention: false });

    view.rerender({ ids: ["b"], merged: false, worktreeId: "wt-1" });

    expect(view.result.current).toMatchObject({ working: false, attention: true });
  });

  it("follows the merged flag without a fleet push", () => {
    push([run("a", { agentState: "idle" })]);
    const { view } = renderCounted({ ids: ["a"], merged: false, worktreeId: "wt-1" });
    expect(view.result.current).toMatchObject({ finished: false, cleanup: false });

    view.rerender({ ids: ["a"], merged: true, worktreeId: "wt-1" });
    expect(view.result.current).toMatchObject({ finished: true, cleanup: true });

    view.rerender({ ids: ["a"], merged: false, worktreeId: "wt-1" });
    expect(view.result.current).toMatchObject({ finished: false, cleanup: false });
  });

  it("reads the plugin entry for the worktree it is given", () => {
    push([]);
    setPluginAttention([
      ["wt-1", { attention: true }],
      ["wt-2", { working: true }],
    ]);
    const { view } = renderCounted({ ids: [], merged: false, worktreeId: "wt-1" });
    expect(view.result.current).toMatchObject({ attention: true, working: false });

    view.rerender({ ids: [], merged: false, worktreeId: "wt-2" });

    expect(view.result.current).toMatchObject({ attention: false, working: true });
  });
});
