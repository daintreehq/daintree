// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { createStore } from "zustand/vanilla";
import {
  FLEET_BROADCAST_HISTORY_KEY,
  FLEET_LARGE_PASTE_BATCH_SIZE,
  FLEET_LARGE_PASTE_BYTE_THRESHOLD,
  buildFleetBroadcastRecipeContext,
  getFleetBroadcastByteLength,
  resolveFleetBroadcastTargetIds,
} from "../fleetBroadcast";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { usePanelStore } from "@/store/panelStore";
import { setCurrentViewStore } from "@/store/createWorktreeStore";
import type { WorktreeViewState, WorktreeViewActions } from "@/store/createWorktreeStore";
import type { PtyPanelData } from "@shared/types/panel";
import type { WorktreeSnapshot } from "@shared/types";

function resetStores() {
  useFleetArmingStore.setState({
    armedIds: new Set<string>(),
    armOrder: [],
    armOrderById: {},
    lastArmedId: null,
  });
  usePanelStore.setState({ panelsById: {}, panelIds: [] });
}

function seedPanels(terminals: PtyPanelData[]): void {
  const panelsById: Record<string, PtyPanelData> = {};
  const panelIds: string[] = [];
  for (const t of terminals) {
    panelsById[t.id] = t;
    panelIds.push(t.id);
  }
  usePanelStore.setState({ panelsById, panelIds });
}

function makeAgent(id: string, overrides: Partial<PtyPanelData> = {}): PtyPanelData {
  return {
    id,
    title: id,
    kind: "terminal",
    cwd: "/tmp",
    cols: 80,
    rows: 24,
    detectedAgentId: "claude",
    worktreeId: "wt-1",
    projectId: "proj-1",
    location: "grid",
    agentState: "idle",
    hasPty: true,
    ...(overrides as object),
  } as PtyPanelData;
}

function makeWorktree(id: string, overrides: Partial<WorktreeSnapshot> = {}): WorktreeSnapshot {
  const overridesObj = overrides as Record<string, unknown>;
  const num = (overridesObj.prNumber as number) ?? 101;
  return {
    id,
    worktreeId: id,
    path: `/tmp/${id}`,
    name: id,
    branch: `feature/${id}`,
    isCurrent: false,
    issueNumber: 42,
    prNumber: 101,
    linked: {
      providerId: "github",
      pr: {
        ref: { providerId: "github", owner: "test", repo: "test", number: num, rawData: {} },
        state: "open",
        url: `https://github.com/test/repo/pull/${num}`,
      },
    },
    ...(overridesObj as object),
  } as WorktreeSnapshot;
}

function installViewStore(worktrees: Map<string, WorktreeSnapshot>) {
  const store = createStore<WorktreeViewState & WorktreeViewActions>(() => ({
    worktrees,
    statusCheckedAt: new Map(),
    workingTreeChangedAtById: new Map(),
    manualAssociations: new Map(),
    version: { epoch: "", seq: 0 },
    tombstones: new Map(),
    deletingIds: new Set(),
    deleteErrors: new Map(),
    deleteErrorArgs: new Map(),
    issueMutatingIds: new Set(),
    issueErrors: new Map(),
    mutationOutbox: new Map(),
    isLoading: false,
    error: null,
    isInitialized: true,
    isReconnecting: false,
    reconnectingAt: null,
    watcherDegraded: false,
    topologyWatcherDark: false,
    applySnapshot: () => {},
    applyUpdate: () => {},
    applyRemove: () => {},
    setManualAssociation: () => {},
    clearManualAssociation: () => {},
    startDelete: () => {},
    retryDelete: () => {},
    clearDeleteError: () => {},
    startAttachIssue: () => {},
    startDetachIssue: () => {},
    pruneAcknowledgedMutations: () => {},
    retryOutboxEntry: () => {},
    dismissOutboxEntry: () => {},
    replayOutboxAfterReconnect: () => {},
    setLoading: () => {},
    setError: () => {},
    setFatalError: () => {},
    setReconnecting: () => {},
    setWatcherDegraded: () => {},
    setTopologyWatcherDark: () => {},
    applyIssueNotFound: () => {},
  }));
  setCurrentViewStore(store);
}

describe("fleetBroadcast constants", () => {
  it("history key is stable", () => {
    expect(FLEET_BROADCAST_HISTORY_KEY).toBe("fleet-broadcast");
  });
  it("large-paste byte threshold matches spec (100 KB)", () => {
    expect(FLEET_LARGE_PASTE_BYTE_THRESHOLD).toBe(102_400);
  });
  it("large-paste batch size is a conservative IPC fan-out", () => {
    expect(FLEET_LARGE_PASTE_BATCH_SIZE).toBe(5);
  });
});

describe("getFleetBroadcastByteLength", () => {
  it("counts ASCII bytes", () => {
    expect(getFleetBroadcastByteLength("hello")).toBe(5);
  });
  it("counts multi-byte UTF-8 characters (emoji = 4 bytes)", () => {
    expect(getFleetBroadcastByteLength("✓")).toBe(3);
    expect(getFleetBroadcastByteLength("🚀")).toBe(4);
  });
});

describe("resolveFleetBroadcastTargetIds", () => {
  beforeEach(() => {
    resetStores();
  });

  it("returns empty array when nothing is armed", () => {
    expect(resolveFleetBroadcastTargetIds()).toEqual([]);
  });

  it("drops trashed/background/dock/non-pty terminals silently", () => {
    seedPanels([
      makeAgent("ok"),
      makeAgent("trashed", { location: "trash" }),
      makeAgent("bg", { location: "background" }),
      makeAgent("noPty", { hasPty: false }),
      makeAgent("docked", { location: "dock" }),
    ]);
    useFleetArmingStore.getState().armIds(["ok", "trashed", "bg", "noPty", "docked"]);
    expect(resolveFleetBroadcastTargetIds()).toEqual(["ok"]);
  });

  it("preserves armOrder ordering", () => {
    seedPanels([makeAgent("a"), makeAgent("b"), makeAgent("c")]);
    useFleetArmingStore.getState().armIds(["c", "a", "b"]);
    expect(resolveFleetBroadcastTargetIds()).toEqual(["c", "a", "b"]);
  });

  it("drops ids that no longer exist in panel store", () => {
    seedPanels([makeAgent("a")]);
    useFleetArmingStore.getState().armIds(["a", "ghost"]);
    expect(resolveFleetBroadcastTargetIds()).toEqual(["a"]);
  });

  it("includes plain terminals and ex-agent shells while their PTY is live", () => {
    seedPanels([
      makeAgent("a"),
      makeAgent("p", {
        kind: "terminal",
        detectedAgentId: undefined,
        everDetectedAgent: true,
      }),
    ]);
    useFleetArmingStore.getState().armIds(["a", "p"]);
    expect(resolveFleetBroadcastTargetIds()).toEqual(["a", "p"]);
  });
});

describe("buildFleetBroadcastRecipeContext", () => {
  beforeEach(() => {
    resetStores();
    const worktrees = new Map<string, WorktreeSnapshot>();
    worktrees.set(
      "wt-1",
      makeWorktree("wt-1", {
        path: "/repo/wt-1",
        branch: "feature/x",
        issueNumber: 7,
        prNumber: 9,
      })
    );
    installViewStore(worktrees);
  });

  it("resolves the context fields from the worktree store", () => {
    seedPanels([makeAgent("t1", { worktreeId: "wt-1" })]);
    const ctx = buildFleetBroadcastRecipeContext("t1");
    expect(ctx).toEqual({
      issueNumber: 7,
      prNumber: 9,
      worktreePath: "/repo/wt-1",
      branchName: "feature/x",
    });
  });

  it("returns null for unknown terminal id", () => {
    expect(buildFleetBroadcastRecipeContext("missing")).toBeNull();
  });

  it("returns null when panel has no worktreeId", () => {
    seedPanels([makeAgent("orphan", { worktreeId: undefined as unknown as string })]);
    expect(buildFleetBroadcastRecipeContext("orphan")).toBeNull();
  });

  it("returns null when worktree missing from view store", () => {
    seedPanels([makeAgent("t2", { worktreeId: "wt-missing" })]);
    expect(buildFleetBroadcastRecipeContext("t2")).toBeNull();
  });

  it("falls back to worktree.name when branch is unset", () => {
    const worktrees = new Map<string, WorktreeSnapshot>();
    worktrees.set("wt-x", makeWorktree("wt-x", { branch: undefined, name: "fallback-name" }));
    installViewStore(worktrees);
    seedPanels([makeAgent("t3", { worktreeId: "wt-x" })]);
    expect(buildFleetBroadcastRecipeContext("t3")?.branchName).toBe("fallback-name");
  });
});
