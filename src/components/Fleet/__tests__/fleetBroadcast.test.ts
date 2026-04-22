// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { createStore } from "zustand/vanilla";
import {
  FLEET_BROADCAST_HISTORY_KEY,
  FLEET_CONFIRM_BYTE_THRESHOLD,
  FLEET_DESTRUCTIVE_RE,
  FLEET_LARGE_PASTE_BATCH_SIZE,
  FLEET_LARGE_PASTE_BYTE_THRESHOLD,
  areAgentStatesBroadcastCompatible,
  buildFleetBroadcastRecipeContext,
  getFleetBroadcastByteLength,
  getFleetBroadcastWarnings,
  needsFleetBroadcastConfirmation,
  resolveFleetBroadcastByOrigin,
  resolveFleetBroadcastTargetIds,
} from "../fleetBroadcast";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { usePanelStore } from "@/store/panelStore";
import { setCurrentViewStore } from "@/store/createWorktreeStore";
import type { WorktreeViewState, WorktreeViewActions } from "@/store/createWorktreeStore";
import type { TerminalInstance, WorktreeSnapshot } from "@shared/types";

function resetStores() {
  useFleetArmingStore.setState({
    armedIds: new Set<string>(),
    armOrder: [],
    armOrderById: {},
    lastArmedId: null,
  });
  usePanelStore.setState({ panelsById: {}, panelIds: [] });
}

function seedPanels(terminals: TerminalInstance[]): void {
  const panelsById: Record<string, TerminalInstance> = {};
  const panelIds: string[] = [];
  for (const t of terminals) {
    panelsById[t.id] = t;
    panelIds.push(t.id);
  }
  usePanelStore.setState({ panelsById, panelIds });
}

function makeAgent(id: string, overrides: Partial<TerminalInstance> = {}): TerminalInstance {
  return {
    id,
    title: id,
    type: "terminal",
    kind: "agent",
    agentId: "claude",
    worktreeId: "wt-1",
    projectId: "proj-1",
    location: "grid",
    agentState: "idle",
    hasPty: true,
    ...(overrides as object),
  } as TerminalInstance;
}

function makeWorktree(id: string, overrides: Partial<WorktreeSnapshot> = {}): WorktreeSnapshot {
  return {
    id,
    worktreeId: id,
    path: `/tmp/${id}`,
    name: id,
    branch: `feature/${id}`,
    isCurrent: false,
    issueNumber: 42,
    prNumber: 101,
    ...(overrides as object),
  } as WorktreeSnapshot;
}

function installViewStore(worktrees: Map<string, WorktreeSnapshot>) {
  const store = createStore<WorktreeViewState & WorktreeViewActions>(() => ({
    worktrees,
    version: 0,
    isLoading: false,
    error: null,
    isInitialized: true,
    isReconnecting: false,
    nextVersion: () => 0,
    applySnapshot: () => {},
    applyUpdate: () => {},
    applyRemove: () => {},
    setLoading: () => {},
    setError: () => {},
    setFatalError: () => {},
    setReconnecting: () => {},
  }));
  setCurrentViewStore(store);
}

describe("fleetBroadcast constants", () => {
  it("history key is stable", () => {
    expect(FLEET_BROADCAST_HISTORY_KEY).toBe("fleet-broadcast");
  });
  it("confirmation threshold matches spec (512 bytes)", () => {
    expect(FLEET_CONFIRM_BYTE_THRESHOLD).toBe(512);
  });
  it("large-paste byte threshold matches spec (100 KB)", () => {
    expect(FLEET_LARGE_PASTE_BYTE_THRESHOLD).toBe(102_400);
  });
  it("large-paste batch size is a conservative IPC fan-out", () => {
    expect(FLEET_LARGE_PASTE_BATCH_SIZE).toBe(5);
  });
});

describe("FLEET_DESTRUCTIVE_RE", () => {
  const positives = [
    "rm -rf /tmp/foo",
    "rm -r ./build",
    "rm -f something",
    "rm -rfv node_modules",
    "rm -Rf /tmp/foo",
    "git clean -fd",
    "git clean -fdx",
    "sudo apt install",
    "drop table users",
    "DROP TABLE USERS",
    "truncate table sessions",
    "chmod -R 777 /",
    "mkfs.ext4 /dev/sda1",
    "dd if=/dev/zero of=/dev/sda",
    ":(){ :|:& };:",
  ];
  for (const cmd of positives) {
    it(`flags: ${cmd}`, () => {
      expect(FLEET_DESTRUCTIVE_RE.test(cmd)).toBe(true);
    });
  }

  const negatives = [
    "echo hello",
    "git status",
    "npm test",
    "ls -la",
    "echo 'drop it'",
    "please rm the unused code",
  ];
  for (const cmd of negatives) {
    it(`does not flag: ${cmd}`, () => {
      expect(FLEET_DESTRUCTIVE_RE.test(cmd)).toBe(false);
    });
  }
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

describe("getFleetBroadcastWarnings", () => {
  it("detects multi-line payloads", () => {
    expect(getFleetBroadcastWarnings("one\ntwo").multiline).toBe(true);
    expect(getFleetBroadcastWarnings("one two").multiline).toBe(false);
  });

  it("detects byte-length overflow", () => {
    const small = "a".repeat(FLEET_CONFIRM_BYTE_THRESHOLD);
    const large = "a".repeat(FLEET_CONFIRM_BYTE_THRESHOLD + 1);
    expect(getFleetBroadcastWarnings(small).overByteLimit).toBe(false);
    expect(getFleetBroadcastWarnings(large).overByteLimit).toBe(true);
  });

  it("counts UTF-8 bytes — 509 ASCII + rocket (4 bytes) crosses to 513", () => {
    const borderline = "a".repeat(FLEET_CONFIRM_BYTE_THRESHOLD - 3) + "🚀";
    expect(getFleetBroadcastByteLength(borderline)).toBe(FLEET_CONFIRM_BYTE_THRESHOLD + 1);
    expect(getFleetBroadcastWarnings(borderline).overByteLimit).toBe(true);
  });

  it("treats exactly 512 UTF-8 bytes as within limit", () => {
    const exact = "a".repeat(FLEET_CONFIRM_BYTE_THRESHOLD - 4) + "🚀";
    expect(getFleetBroadcastByteLength(exact)).toBe(FLEET_CONFIRM_BYTE_THRESHOLD);
    expect(getFleetBroadcastWarnings(exact).overByteLimit).toBe(false);
  });

  it("detects destructive commands", () => {
    expect(getFleetBroadcastWarnings("rm -rf node_modules").destructive).toBe(true);
    expect(getFleetBroadcastWarnings("echo 'hi'").destructive).toBe(false);
  });
});

describe("needsFleetBroadcastConfirmation", () => {
  it("returns true when any warning fires", () => {
    expect(needsFleetBroadcastConfirmation("multi\nline")).toBe(true);
    expect(needsFleetBroadcastConfirmation("rm -rf .")).toBe(true);
    expect(needsFleetBroadcastConfirmation("x".repeat(700))).toBe(true);
  });
  it("returns false for short, single-line, safe text", () => {
    expect(needsFleetBroadcastConfirmation("run the test")).toBe(false);
  });
});

describe("resolveFleetBroadcastTargetIds", () => {
  beforeEach(() => {
    resetStores();
  });

  it("returns empty array when nothing is armed", () => {
    expect(resolveFleetBroadcastTargetIds()).toEqual([]);
  });

  it("drops trashed/background/non-pty terminals silently", () => {
    seedPanels([
      makeAgent("ok"),
      makeAgent("trashed", { location: "trash" }),
      makeAgent("bg", { location: "background" }),
      makeAgent("noPty", { hasPty: false }),
    ]);
    useFleetArmingStore.getState().armIds(["ok", "trashed", "bg", "noPty"]);
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

  it("includes a plain terminal running a detected agent", () => {
    seedPanels([
      makeAgent("a"),
      makeAgent("p", {
        kind: "terminal",
        agentId: undefined,
        detectedAgentId: "claude",
      }),
    ]);
    useFleetArmingStore.getState().armIds(["a", "p"]);
    expect(resolveFleetBroadcastTargetIds()).toEqual(["a", "p"]);
  });

  it("keeps a plain terminal armed after detected agent exits (sticky everDetectedAgent)", () => {
    seedPanels([
      makeAgent("a"),
      makeAgent("p", {
        kind: "terminal",
        agentId: undefined,
        detectedAgentId: undefined,
        everDetectedAgent: true,
      }),
    ]);
    useFleetArmingStore.getState().armIds(["a", "p"]);
    expect(resolveFleetBroadcastTargetIds()).toEqual(["a", "p"]);
  });
});

describe("areAgentStatesBroadcastCompatible", () => {
  it("treats working and running as one group", () => {
    expect(areAgentStatesBroadcastCompatible("working", "running")).toBe(true);
    expect(areAgentStatesBroadcastCompatible("running", "working")).toBe(true);
  });
  it("treats completed and exited as one group", () => {
    expect(areAgentStatesBroadcastCompatible("completed", "exited")).toBe(true);
  });
  it("keeps waiting and idle distinct", () => {
    expect(areAgentStatesBroadcastCompatible("waiting", "idle")).toBe(false);
    expect(areAgentStatesBroadcastCompatible("waiting", "waiting")).toBe(true);
  });
  it("keeps waiting distinct from working", () => {
    expect(areAgentStatesBroadcastCompatible("waiting", "working")).toBe(false);
  });
  it("treats two unknown states as compatible (non-agent panes)", () => {
    expect(areAgentStatesBroadcastCompatible(null, undefined)).toBe(true);
  });
  it("treats unknown vs known as incompatible", () => {
    expect(areAgentStatesBroadcastCompatible(null, "waiting")).toBe(false);
  });
});

describe("resolveFleetBroadcastByOrigin", () => {
  beforeEach(() => {
    resetStores();
  });

  it("returns empty matched and diverged when nothing armed", () => {
    expect(resolveFleetBroadcastByOrigin("anything")).toEqual({ matched: [], diverged: [] });
  });

  it("excludes the origin pane from matched", () => {
    seedPanels([
      makeAgent("a", { agentState: "waiting" }),
      makeAgent("b", { agentState: "waiting" }),
    ]);
    useFleetArmingStore.getState().armIds(["a", "b"]);
    const result = resolveFleetBroadcastByOrigin("a");
    expect(result.matched).toEqual(["b"]);
    expect(result.diverged).toEqual([]);
  });

  it("partitions peers by state-group compatibility against the origin", () => {
    seedPanels([
      makeAgent("origin", { agentState: "waiting" }),
      makeAgent("peer-waiting", { agentState: "waiting" }),
      makeAgent("peer-working", { agentState: "working" }),
      makeAgent("peer-running", { agentState: "running" }),
      makeAgent("peer-idle", { agentState: "idle" }),
    ]);
    useFleetArmingStore
      .getState()
      .armIds(["origin", "peer-waiting", "peer-working", "peer-running", "peer-idle"]);
    const result = resolveFleetBroadcastByOrigin("origin");
    expect(result.matched).toEqual(["peer-waiting"]);
    expect(result.diverged.sort()).toEqual(["peer-idle", "peer-running", "peer-working"]);
  });

  it("groups working and running peers when origin is working", () => {
    seedPanels([
      makeAgent("origin", { agentState: "working" }),
      makeAgent("peer-running", { agentState: "running" }),
      makeAgent("peer-waiting", { agentState: "waiting" }),
    ]);
    useFleetArmingStore.getState().armIds(["origin", "peer-running", "peer-waiting"]);
    const result = resolveFleetBroadcastByOrigin("origin");
    expect(result.matched).toEqual(["peer-running"]);
    expect(result.diverged).toEqual(["peer-waiting"]);
  });

  it("drops trashed/background peers from both matched and diverged", () => {
    seedPanels([
      makeAgent("origin", { agentState: "waiting" }),
      makeAgent("ok", { agentState: "waiting" }),
      makeAgent("trashed", { agentState: "waiting", location: "trash" }),
      makeAgent("noPty", { agentState: "waiting", hasPty: false }),
    ]);
    useFleetArmingStore.getState().armIds(["origin", "ok", "trashed", "noPty"]);
    const result = resolveFleetBroadcastByOrigin("origin");
    expect(result.matched).toEqual(["ok"]);
    expect(result.diverged).toEqual([]);
  });

  it("preserves armOrder ordering for matched peers", () => {
    seedPanels([
      makeAgent("a", { agentState: "waiting" }),
      makeAgent("b", { agentState: "waiting" }),
      makeAgent("c", { agentState: "waiting" }),
    ]);
    useFleetArmingStore.getState().armIds(["c", "a", "b"]);
    const result = resolveFleetBroadcastByOrigin("a");
    expect(result.matched).toEqual(["c", "b"]);
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
